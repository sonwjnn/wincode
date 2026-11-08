import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { isObjectLike, isString } from "@wincode/utils";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import {
	type AttachmentReference,
	attachmentReferenceToFilePart,
} from "@/modules/sessions/attachment-reference";
import type { SessionMessage } from "@/modules/sessions/message";
import {
	type AttachmentInput,
	type AttachmentMetadataRecord,
	type AttachmentMetadataRepository,
	createSessionAttachmentStore,
	estimateAttachmentTokens,
	formatAttachmentUnavailableMarker,
	getAttachmentReference,
	type SessionAttachmentStore,
} from "@/modules/sessions/storage/attachment-store";
import { resolveSessionLogFilePath } from "@/modules/sessions/storage/path";
import {
	createSessionLogEvent,
	createSessionLogHeader,
	encodeSessionLogLine,
} from "@/modules/sessions/storage/session-jsonl-codec";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import { toSessionId } from "@/shared/identifiers";
import { agentId, agentTurnId, sessionMessageId } from "../support/identifiers";

const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const DATA_IMAGE_URL_PATTERN = /^data:image\/png;base64,/u;
const LARGE_PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
	0x52, 0, 0, 4, 0, 0, 0, 4, 0,
]);

const ingestReference = async (
	attachments: SessionAttachmentStore,
	input: AttachmentInput,
	signal?: AbortSignal
): Promise<AttachmentReference> =>
	(await attachments.ingest(input, signal)).reference;

const createRepository = (): AttachmentMetadataRepository => {
	const records = new Map<string, AttachmentMetadataRecord>();
	return {
		delete: (attachmentId) => {
			records.delete(attachmentId);
		},
		get: (attachmentId) => records.get(attachmentId),
		list: () => [...records.values()],
		put: (record) => {
			records.set(record.attachmentId, record);
		},
	};
};

test("ingests exact bytes once and preserves per-reference filenames", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({ repository, root });

	const first = await ingestReference(attachments, {
		bytes: PNG_BYTES,
		filename: "first.png",
		mediaType: "image/png",
	});
	const second = await ingestReference(attachments, {
		bytes: PNG_BYTES,
		filename: "second.png",
		mediaType: "image/png",
	});

	expect(second.attachmentId).toBe(first.attachmentId);
	expect(first.filename).toBe("first.png");
	expect(second.filename).toBe("second.png");
	expect(repository.list()).toHaveLength(1);

	const resolved = await attachments.resolve({
		...second,
		height: 1,
		width: 1,
	});
	expect(resolved).toMatchObject({
		availability: "available",
		bytes: PNG_BYTES,
		reference: second,
	});

	expect(resolved.reference).not.toHaveProperty("height");
	expect(resolved.reference).not.toHaveProperty("width");

	const blobPath = path.join(root, repository.list()[0]?.blobKey ?? "");
	expect(await Bun.file(blobPath).bytes()).toEqual(PNG_BYTES);
});

test("verified attachment dimensions override forged token-budget metadata", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const attachments = createSessionAttachmentStore({
		repository: createRepository(),
		root,
	});
	const storedReference = await ingestReference(attachments, {
		bytes: LARGE_PNG_BYTES,
		filename: "large.png",
		mediaType: "image/png",
	});
	const forgedReference = {
		...storedReference,
		height: 1,
		width: 1,
	};
	expect(estimateAttachmentTokens(forgedReference)).toBe(256);

	const resolution = await attachments.resolve(forgedReference);
	if (resolution.availability !== "available") {
		throw new Error("verified attachment was not available");
	}
	const canonicalReference = resolution.reference;
	expect(canonicalReference).toMatchObject({ height: 1024, width: 1024 });
	expect(estimateAttachmentTokens(canonicalReference)).toBe(1024);

	const hydrated = await attachments.hydrateMessagesWithStats(
		[
			fromPartial<SessionMessage>({
				id: sessionMessageId("user-1"),
				parts: [attachmentReferenceToFilePart(canonicalReference)],
				role: "user",
			}),
		],
		{ maxTokens: 512, purpose: "display" }
	);

	expect(hydrated.stats).toMatchObject({
		omittedCount: 1,
		retainedCount: 0,
	});
	const hydratedPart = hydrated.messages[0]?.parts[0];
	expect(hydratedPart).toMatchObject({
		height: 1024,
		type: "file",
		width: 1024,
	});
	const hydratedReference = getAttachmentReference(hydratedPart);
	if (!hydratedReference) {
		throw new Error("hydrated attachment reference was not available");
	}
	expect(estimateAttachmentTokens(hydratedReference)).toBe(1024);
});

test("externalizes inline image parts and hydrates them only on request", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const attachments = createSessionAttachmentStore({
		repository: createRepository(),
		root,
	});
	const inlineUrl = `data:image/png;base64,${PNG_BYTES.toBase64()}`;
	const message = fromPartial<SessionMessage>({
		id: sessionMessageId("user-1"),
		parts: [
			{ text: "inspect [Image 1]", type: "text" },
			{
				filename: "diagram.png",
				mediaType: "image/png",
				type: "file",
				url: inlineUrl,
			},
		],
		role: "user",
	});

	const externalization = await attachments.externalizeMessagesWithLease([
		message,
	]);
	const persisted = externalization.messages;
	const persistedPart = persisted[0]?.parts[1];
	expect(getAttachmentReference(persistedPart)).not.toBeNull();
	const parsedReference = getAttachmentReference(persistedPart);
	if (!parsedReference) {
		throw new Error("reference did not parse");
	}
	expect((await attachments.resolve(parsedReference)).availability).toBe(
		"available"
	);
	expect(parsedReference.attachmentId.startsWith("v1-")).toBe(true);
	expect(parsedReference.byteLength).toBe(PNG_BYTES.byteLength);
	expect(parsedReference.filename).toBe("diagram.png");
	expect(parsedReference.mediaType).toBe("image/png");
	expect(
		isObjectLike(persistedPart) &&
			"url" in persistedPart &&
			isString(persistedPart.url) &&
			persistedPart.url.startsWith("attachment://")
	).toBe(true);
	expect(JSON.stringify(persisted)).not.toContain("data:image/png;base64");

	const hydrated = await attachments.hydrateMessages(persisted, {
		purpose: "model",
	});
	expect(hydrated[0]?.parts[1]).toEqual(message.parts[1]);
	await externalization.release();
});

test("returns bounded unavailable markers for missing or corrupted blobs", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({ repository, root });
	const reference = await ingestReference(attachments, {
		bytes: PNG_BYTES,
		filename: "diagram.png",
		mediaType: "image/png",
	});
	const record = repository.get(reference.attachmentId);
	if (!record) {
		throw new Error("metadata was not written");
	}
	const corruptedBytes = new Uint8Array(PNG_BYTES);
	corruptedBytes[corruptedBytes.length - 1] = 0x02;
	await Bun.write(path.join(root, record.blobKey), corruptedBytes);

	const resolved = await attachments.resolve(reference);
	expect(resolved.availability).toBe("corrupt");
	expect(formatAttachmentUnavailableMarker(reference)).toContain(
		reference.attachmentId.slice(0, 12)
	);
	const hydrated = await attachments.hydrateMessages(
		[
			{
				id: sessionMessageId("user-1"),
				parts: [attachmentReferenceToFilePart(reference)],
				role: "user",
			},
		],
		{ purpose: "model" }
	);
	expect(hydrated[0]?.parts[0]).toMatchObject({ type: "text" });
	expect(JSON.stringify(hydrated)).not.toContain("data:image");
});

test("rejects required hydration when a committed attachment is corrupt", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({ repository, root });
	const reference = await ingestReference(attachments, {
		bytes: PNG_BYTES,
		filename: "missing.png",
		mediaType: "image/png",
	});
	const record = repository.get(reference.attachmentId);
	if (!record) {
		throw new Error("attachment metadata was not written");
	}
	const corruptedBytes = new Uint8Array(PNG_BYTES);
	corruptedBytes[corruptedBytes.length - 1] = 0x02;
	await Bun.write(path.join(root, record.blobKey), corruptedBytes);

	await expect(
		attachments.hydrateMessages(
			[
				{
					id: sessionMessageId("steered-message"),
					parts: [attachmentReferenceToFilePart(reference)],
					role: "user",
				},
			],
			{ failOnMissing: true, purpose: "model" }
		)
	).rejects.toThrow("One or more attachments are unavailable.");
});

test("keeps only newest attachments within an explicit media budget", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const attachments = createSessionAttachmentStore({
		repository: createRepository(),
		root,
	});
	const references = await Promise.all(
		["old.png", "new.png"].map((filename) =>
			ingestReference(attachments, {
				bytes: PNG_BYTES,
				filename,
				mediaType: "image/png",
			})
		)
	);
	const [oldReference, newReference] = references;
	if (!(oldReference && newReference)) {
		throw new Error("attachments were not ingested");
	}
	const messages = fromPartial<SessionMessage[]>([
		{
			id: sessionMessageId("old"),
			parts: [attachmentReferenceToFilePart(oldReference)],
			role: "user",
		},
		{
			id: sessionMessageId("new"),
			parts: [attachmentReferenceToFilePart(newReference)],
			role: "user",
		},
	]);

	const hydration = await attachments.hydrateMessagesWithStats(messages, {
		maxAttachments: 1,
		maxBytes: PNG_BYTES.byteLength,
		maxTokens: 10_000,
		purpose: "compaction",
	});
	const hydrated = hydration.messages;
	expect(hydration.stats).toEqual({
		missingBytes: 0,
		missingCount: 0,
		omittedBytes: PNG_BYTES.byteLength,
		omittedCount: 1,
		retainedBytes: PNG_BYTES.byteLength,
		retainedCount: 1,
	});
	expect(hydrated[0]?.parts[0]).toMatchObject({
		text: expect.stringContaining("Attachment payload omitted"),
		type: "text",
	});
	expect(hydrated[1]?.parts[0]).toMatchObject({
		url: expect.stringMatching(DATA_IMAGE_URL_PATTERN),
	});
});

test("prioritizes the latest user turn over retained media limits", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const attachments = createSessionAttachmentStore({
		repository: createRepository(),
		root,
	});
	const oldReference = await ingestReference(attachments, {
		bytes: PNG_BYTES,
		filename: "old.png",
		mediaType: "image/png",
	});
	const currentReference = await ingestReference(attachments, {
		bytes: new Uint8Array([...PNG_BYTES, 0x04]),
		filename: "current.png",
		mediaType: "image/png",
	});
	const hydrated = await attachments.hydrateMessages(
		fromPartial<SessionMessage[]>([
			{
				id: sessionMessageId("old"),
				parts: [attachmentReferenceToFilePart(oldReference)],
				role: "user",
			},
			{
				id: sessionMessageId("current"),
				parts: [attachmentReferenceToFilePart(currentReference)],
				role: "user",
			},
		]),
		{
			maxAttachments: 0,
			maxBytes: 0,
			priorityMessageId: sessionMessageId("current"),
			purpose: "model",
		}
	);
	expect(hydrated[0]?.parts[0]).toMatchObject({ type: "text" });
	expect(hydrated[1]?.parts[0]).toMatchObject({
		url: expect.stringMatching(DATA_IMAGE_URL_PATTERN),
	});
});

test("collects only unreferenced blobs and reports bytes without content", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const liveLease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "live.png",
		mediaType: "image/png",
	});
	const live = liveLease.reference;
	const deadLease = await attachments.ingest({
		bytes: new Uint8Array([...PNG_BYTES, 0x02]),
		filename: "dead.png",
		mediaType: "image/png",
	});
	const dead = deadLease.reference;
	const orphanBytes = new Uint8Array(PNG_BYTES.byteLength + 1);
	orphanBytes.set(PNG_BYTES);
	orphanBytes[orphanBytes.length - 1] = 0x03;
	const orphanLease = await attachments.ingest({
		bytes: orphanBytes,
		filename: "orphan.png",
		mediaType: "image/png",
	});
	const orphan = orphanLease.reference;
	const orphanRecord = repository.get(orphan.attachmentId);
	if (!orphanRecord) {
		throw new Error("orphan attachment metadata missing");
	}
	const temporaryPath = `${path.join(root, orphanRecord.blobKey)}.crashed.tmp`;
	await Bun.write(temporaryPath, PNG_BYTES);
	expect((await fs.stat(temporaryPath)).size).toBe(PNG_BYTES.byteLength);
	repository.delete(orphan.attachmentId);
	await Promise.all([deadLease.release(), orphanLease.release()]);
	const report = await attachments.collect({
		liveAttachmentIds: [live.attachmentId],
		safetyWindowMs: 0,
	});
	expect(report.reclaimedCount).toBe(1);
	expect(report.orphanCount).toBe(2);
	expect(repository.get(dead.attachmentId)).toBeUndefined();
	const liveRecord = repository.get(live.attachmentId);
	if (!liveRecord) {
		throw new Error("live attachment metadata missing");
	}
	expect(await fs.stat(path.join(root, liveRecord.blobKey))).toBeTruthy();
	await liveLease.release();
});

test("a staging pin keeps a blob live until an uncommitted owner is released", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const stagedLease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "staged.png",
		mediaType: "image/png",
	});
	const staged = stagedLease.reference;
	const stagedRecord = repository.get(staged.attachmentId);
	if (!stagedRecord) {
		throw new Error("staged attachment metadata missing");
	}

	const pinnedReport = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(pinnedReport.reclaimedCount).toBe(0);
	expect(await fs.stat(path.join(root, stagedRecord.blobKey))).toBeTruthy();

	await stagedLease.release();
	const cancelledReport = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(cancelledReport.reclaimedCount).toBe(1);
});

test("separate blob roots cannot release each other's staging pins", async () => {
	const firstRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-attachments-")
	);
	const secondRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-attachments-")
	);
	const firstRepository = createRepository();
	const firstStore = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository: firstRepository,
		root: firstRoot,
	});
	const secondStore = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository: createRepository(),
		root: secondRoot,
	});
	const stagedLease = await firstStore.ingest({
		bytes: PNG_BYTES,
		filename: "staged.png",
		mediaType: "image/png",
	});
	const staged = stagedLease.reference;

	await secondStore.collect({
		liveAttachmentIds: [staged.attachmentId],
		safetyWindowMs: 0,
	});
	const collection = await firstStore.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});

	expect(collection.reclaimedCount).toBe(0);
	expect(firstRepository.get(staged.attachmentId)).toBeDefined();
});

test("attachment collection reads flat JSONL liveness and ignores non-log entries", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const lifecycleRoot = path.join(root, "sessions");
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		lifecycleRoot,
		now: () => new Date(Date.now() + 1000),
		repository,
		root: path.join(root, "blobs"),
	});
	const lease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "live.png",
		mediaType: "image/png",
	});
	const reference = lease.reference;
	await lease.release();
	const sessionId = toSessionId("flat-attachment-liveness-session");
	const timestamp = new Date().toISOString();
	const header = createSessionLogHeader(
		sessionId,
		crypto.randomUUID(),
		timestamp
	);
	const record = buildUserSessionRecord({
		agentId: agentId("attachment-liveness-agent"),
		message: fromPartial<SessionMessage>({
			id: sessionMessageId("flat-attachment-liveness-message"),
			parts: [attachmentReferenceToFilePart(reference)],
			role: "user",
		}),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("flat-attachment-liveness-turn"),
	});
	const created = createSessionLogEvent({
		operationId: `create-${sessionId}`,
		payload: {
			createdAt: timestamp,
			editMode: "hashline",
			initialRecord: record,
			lastMessageAt: timestamp,
			pinned: false,
			title: "Untitled Session",
		},
		previousHash: header.entryHash,
		sequence: 1,
		sessionId,
		timestamp,
		type: "session.created",
	});
	try {
		await Bun.write(
			resolveSessionLogFilePath(lifecycleRoot, sessionId),
			new Uint8Array([
				...encodeSessionLogLine(header),
				...encodeSessionLogLine(created),
			])
		);
		const legacyDirectory = path.join(
			lifecycleRoot,
			"legacy-attachment-session"
		);
		await fs.mkdir(legacyDirectory, { recursive: true });
		await Bun.write(
			path.join(legacyDirectory, "session.jsonl"),
			"not discovered as an authoritative log"
		);
		await Bun.write(path.join(lifecycleRoot, ".hidden.jsonl"), "ignored");
		await Bun.write(path.join(lifecycleRoot, "notes.txt"), "ignored");
		await fs.mkdir(path.join(lifecycleRoot, "directory.jsonl"));

		const report = await attachments.collect({
			liveAttachmentIds: [],
			safetyWindowMs: 0,
		});
		expect(report.reclaimedCount).toBe(0);
		expect(repository.get(reference.attachmentId)).toBeDefined();
	} finally {
		await fs.rm(root, { force: true, recursive: true });
	}
});

test("reclaims an uncommitted blob after its staging owner process has exited", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const lifecycleRoot = path.join(root, "sessions");
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		lifecycleRoot,
		now: () => new Date(Date.now() + 1000),
		repository,
		root: path.join(root, "blobs"),
	});
	const abandonedLease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "abandoned.png",
		mediaType: "image/png",
	});
	const abandoned = abandonedLease.reference;
	const pinDirectory = path.join(root, "session-control", "attachment-pins");
	const [pinName] = await fs.readdir(pinDirectory);
	if (pinName === undefined) {
		throw new Error("staging pin was not published");
	}
	const pinPath = path.join(pinDirectory, pinName);
	const pin = (await Bun.file(pinPath).json()) as Record<string, unknown>;
	await Bun.write(
		pinPath,
		JSON.stringify({ ...pin, processId: Number.MAX_SAFE_INTEGER })
	);

	const report = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(report.reclaimedCount).toBe(1);
	expect(repository.get(abandoned.attachmentId)).toBeUndefined();
});

test("releasing a retained owner leaves a separate staged owner live", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const inlineUrl = `data:image/png;base64,${PNG_BYTES.toBase64()}`;
	const stagedOwner = await attachments.externalizeMessagesWithLease([
		fromPartial<SessionMessage>({
			id: sessionMessageId("staged-owner"),
			parts: [
				{
					filename: "shared.png",
					mediaType: "image/png",
					type: "file",
					url: inlineUrl,
				},
			],
			role: "user",
		}),
	]);
	const reference = getAttachmentReference(stagedOwner.messages[0]?.parts[0]);
	if (!reference) {
		throw new Error("staged attachment was not externalized");
	}
	const record = repository.get(reference.attachmentId);
	if (!record) {
		throw new Error("staged attachment metadata missing");
	}

	await attachments.retain([reference.attachmentId]);
	await attachments.release([reference.attachmentId]);
	const stagedReport = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(stagedReport.reclaimedCount).toBe(0);
	expect(await fs.stat(path.join(root, record.blobKey))).toBeTruthy();

	await stagedOwner.release();
	const releasedReport = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(releasedReport.reclaimedCount).toBe(1);
});

test("collection keeps a staged owner after another source references its blob", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const stagedOwner = await attachments.externalizeMessagesWithLease([
		fromPartial<SessionMessage>({
			id: sessionMessageId("staged-owner"),
			parts: [
				{
					filename: "shared.png",
					mediaType: "image/png",
					type: "file",
					url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
				},
			],
			role: "user",
		}),
	]);
	const reference = getAttachmentReference(stagedOwner.messages[0]?.parts[0]);
	if (!reference) {
		throw new Error("staged attachment was not externalized");
	}

	await attachments.collect({
		liveAttachmentIds: [reference.attachmentId],
		safetyWindowMs: 0,
	});
	const stillStaged = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(stillStaged.reclaimedCount).toBe(0);

	await stagedOwner.release();
	const released = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(released.reclaimedCount).toBe(1);
});

test("failed pin unlink rejects and keeps the owner available for retry", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({ repository, root });
	const stagedOwner = await attachments.externalizeMessagesWithLease([
		fromPartial<SessionMessage>({
			id: sessionMessageId("unlink-failure-owner"),
			parts: [
				{
					filename: "unlink-failure.png",
					mediaType: "image/png",
					type: "file",
					url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
				},
			],
			role: "user",
		}),
	]);
	const reference = getAttachmentReference(stagedOwner.messages[0]?.parts[0]);
	if (!reference) {
		throw new Error("staged attachment was not externalized");
	}
	await attachments.retain([reference.attachmentId]);
	const pinDirectory = path.join(root, "session-control", "attachment-pins");
	const pinNames = await fs.readdir(pinDirectory);
	let retainedPinPath: string | undefined;
	for (const pinName of pinNames) {
		const pinPath = path.join(pinDirectory, pinName);
		const pin = (await Bun.file(pinPath).json()) as { kind?: string };
		if (pin.kind === "retained") {
			retainedPinPath = pinPath;
			break;
		}
	}
	if (retainedPinPath === undefined) {
		throw new Error("retained attachment pin was not published");
	}

	await fs.unlink(retainedPinPath);
	await fs.mkdir(retainedPinPath);
	await expect(attachments.release([reference.attachmentId])).rejects.toThrow();
	await fs.rmdir(retainedPinPath);
	await expect(
		attachments.release([reference.attachmentId])
	).resolves.toBeUndefined();
	await stagedOwner.release();
});

test("keeps a retained blob through collection until it is released", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const heldLease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "held.png",
		mediaType: "image/png",
	});
	const held = heldLease.reference;
	const record = repository.get(held.attachmentId);
	if (!record) {
		throw new Error("held attachment metadata missing");
	}

	// A queued composition holds the blob, so a collection pass that would
	// otherwise reclaim it leaves it alone.
	await attachments.retain([held.attachmentId]);
	await heldLease.release();
	const retainedReport = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(retainedReport.reclaimedCount).toBe(0);
	expect(repository.get(held.attachmentId)).toBeDefined();
	expect(await fs.stat(path.join(root, record.blobKey))).toBeTruthy();

	// Once the composition is gone, the same pass reclaims it.
	await attachments.release([held.attachmentId]);
	const releasedReport = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(releasedReport.reclaimedCount).toBe(1);
	expect(repository.get(held.attachmentId)).toBeUndefined();
});

test("releases the final queued attachment pin before collection", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const queuedLease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "queued.png",
		mediaType: "image/png",
	});
	const queued = queuedLease.reference;
	await attachments.retain([queued.attachmentId]);
	await queuedLease.release();

	await attachments.release([queued.attachmentId]);
	const report = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});

	expect(report.reclaimedCount).toBe(1);
});

test("holds a blob retained twice until both holds are released", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const sharedLease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "shared.png",
		mediaType: "image/png",
	});
	const shared = sharedLease.reference;

	await attachments.retain([shared.attachmentId]);
	await attachments.retain([shared.attachmentId]);
	await sharedLease.release();
	await attachments.release([shared.attachmentId]);
	const firstRelease = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(firstRelease.reclaimedCount).toBe(0);

	await attachments.release([shared.attachmentId]);
	// Releasing a blob nothing holds any more changes nothing.
	await attachments.release([shared.attachmentId]);
	const secondRelease = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(secondRelease.reclaimedCount).toBe(1);
});

test("concurrent attachment owners release distinct retained pins", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const attachments = createSessionAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository: createRepository(),
		root,
	});
	const lease = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "shared.png",
		mediaType: "image/png",
	});
	const { attachmentId } = lease.reference;
	await attachments.retain([attachmentId]);
	await attachments.retain([attachmentId]);
	await lease.release();

	await Promise.all([
		attachments.release([attachmentId]),
		attachments.release([attachmentId]),
	]);

	const report = await attachments.collect({
		liveAttachmentIds: [],
		safetyWindowMs: 0,
	});
	expect(report.reclaimedCount).toBe(1);
});

test("validates magic bytes, size, cancellation, and bounded filenames", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const attachments = createSessionAttachmentStore({
		maxBytes: PNG_BYTES.byteLength,
		repository: createRepository(),
		root,
	});

	await expect(
		ingestReference(attachments, {
			bytes: new Uint8Array([0xff, 0xd8, 0xff]),
			filename: "../unsafe\\name.png",
			mediaType: "image/png",
		})
	).rejects.toThrow("match");
	const controller = new AbortController();
	controller.abort();
	await expect(
		ingestReference(
			attachments,
			{
				bytes: PNG_BYTES,
				filename: "safe.png",
				mediaType: "image/png",
			},
			controller.signal
		)
	).rejects.toThrow();
	await expect(
		ingestReference(attachments, {
			bytes: new Uint8Array([...PNG_BYTES, 0x02]),
			filename: "too-large.png",
			mediaType: "image/png",
		})
	).rejects.toThrow("smaller");

	const bounded = await ingestReference(attachments, {
		bytes: PNG_BYTES,
		filename: "../unsafe\\name.png",
		mediaType: "image/png",
	});
	expect(bounded.filename.includes("/")).toBe(false);
	expect(bounded.filename.includes("\\")).toBe(false);
	expect(bounded.filename.length).toBeLessThanOrEqual(128);
});

test("annotates missing blobs without reading payload bytes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createSessionAttachmentStore({ repository, root });
	const reference = await ingestReference(attachments, {
		bytes: PNG_BYTES,
		filename: "missing.png",
		mediaType: "image/png",
	});
	const record = repository.get(reference.attachmentId);
	if (!record) {
		throw new Error("metadata was not written");
	}
	await fs.unlink(path.join(root, record.blobKey));

	const annotated = await attachments.annotateMessagesForDisplay([
		fromPartial<SessionMessage>({
			id: "user-1",
			parts: [attachmentReferenceToFilePart(reference)],
			role: "user",
		}),
	]);
	expect(annotated[0]?.parts[0]).toMatchObject({
		attachmentId: reference.attachmentId,
		displayAvailability: "missing",
	});
});

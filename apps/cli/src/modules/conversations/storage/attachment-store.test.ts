import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodingAgentUIMessage } from "@wincode/ai";
import {
	type AttachmentMetadataRecord,
	type AttachmentMetadataRepository,
	attachmentReferenceToFilePart,
	createConversationAttachmentStore,
	formatAttachmentUnavailableMarker,
	getAttachmentReference,
} from "./attachment-store";

const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const DATA_IMAGE_URL_PATTERN = /^data:image\/png;base64,/u;

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
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createConversationAttachmentStore({ repository, root });

	const first = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "first.png",
		mediaType: "image/png",
	});
	const second = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "second.png",
		mediaType: "image/png",
	});

	expect(second.attachmentId).toBe(first.attachmentId);
	expect(first.filename).toBe("first.png");
	expect(second.filename).toBe("second.png");
	expect(repository.list()).toHaveLength(1);

	const resolved = await attachments.resolve(second);
	expect(resolved).toMatchObject({
		availability: "available",
		bytes: PNG_BYTES,
		reference: second,
	});
	const blobPath = join(root, repository.list()[0]?.blobKey ?? "");
	expect(Uint8Array.from(await readFile(blobPath))).toEqual(PNG_BYTES);
});

test("externalizes inline image parts and hydrates them only on request", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const attachments = createConversationAttachmentStore({
		repository: createRepository(),
		root,
	});
	const inlineUrl = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;
	const message = {
		id: "user-1",
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
	} as unknown as CodingAgentUIMessage;

	const persisted = await attachments.externalizeMessages([message]);
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
		typeof persistedPart === "object" &&
			persistedPart !== null &&
			"url" in persistedPart &&
			typeof persistedPart.url === "string" &&
			persistedPart.url.startsWith("attachment://")
	).toBe(true);
	expect(JSON.stringify(persisted)).not.toContain("data:image/png;base64");

	const hydrated = await attachments.hydrateMessages(persisted, {
		purpose: "model",
	});
	expect(hydrated[0]?.parts[1]).toEqual(message.parts[1]);
});

test("returns bounded unavailable markers for missing or corrupted blobs", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createConversationAttachmentStore({ repository, root });
	const reference = await attachments.ingest({
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
	await writeFile(join(root, record.blobKey), corruptedBytes);

	const resolved = await attachments.resolve(reference);
	expect(resolved.availability).toBe("corrupt");
	expect(formatAttachmentUnavailableMarker(reference)).toContain(
		reference.attachmentId.slice(0, 12)
	);
	const hydrated = await attachments.hydrateMessages(
		[
			{
				id: "user-1",
				parts: [attachmentReferenceToFilePart(reference)],
				role: "user",
			},
		],
		{ purpose: "model" }
	);
	expect(hydrated[0]?.parts[0]).toMatchObject({ type: "text" });
	expect(JSON.stringify(hydrated)).not.toContain("data:image");
});

test("keeps only newest attachments within an explicit media budget", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const attachments = createConversationAttachmentStore({
		repository: createRepository(),
		root,
	});
	const references = await Promise.all(
		["old.png", "new.png"].map((filename) =>
			attachments.ingest({
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
	const messages = [
		{
			id: "old",
			parts: [attachmentReferenceToFilePart(oldReference)],
			role: "user",
		},
		{
			id: "new",
			parts: [attachmentReferenceToFilePart(newReference)],
			role: "user",
		},
	] as unknown as CodingAgentUIMessage[];

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
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const attachments = createConversationAttachmentStore({
		repository: createRepository(),
		root,
	});
	const oldReference = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "old.png",
		mediaType: "image/png",
	});
	const currentReference = await attachments.ingest({
		bytes: new Uint8Array([...PNG_BYTES, 0x04]),
		filename: "current.png",
		mediaType: "image/png",
	});
	const hydrated = await attachments.hydrateMessages(
		[
			{
				id: "old",
				parts: [attachmentReferenceToFilePart(oldReference)],
				role: "user",
			},
			{
				id: "current",
				parts: [attachmentReferenceToFilePart(currentReference)],
				role: "user",
			},
		] as unknown as CodingAgentUIMessage[],
		{
			maxAttachments: 0,
			maxBytes: 0,
			maxTokens: 0,
			priorityMessageId: "current",
			purpose: "model",
		}
	);
	expect(hydrated[0]?.parts[0]).toMatchObject({ type: "text" });
	expect(hydrated[1]?.parts[0]).toMatchObject({
		url: expect.stringMatching(DATA_IMAGE_URL_PATTERN),
	});
});

test("collects only unreferenced blobs and reports bytes without content", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createConversationAttachmentStore({
		now: () => new Date(Date.now() + 1000),
		repository,
		root,
	});
	const live = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "live.png",
		mediaType: "image/png",
	});
	const dead = await attachments.ingest({
		bytes: new Uint8Array([...PNG_BYTES, 0x02]),
		filename: "dead.png",
		mediaType: "image/png",
	});
	const orphanBytes = new Uint8Array(PNG_BYTES.byteLength + 1);
	orphanBytes.set(PNG_BYTES);
	orphanBytes[orphanBytes.length - 1] = 0x03;
	const orphan = await attachments.ingest({
		bytes: orphanBytes,
		filename: "orphan.png",
		mediaType: "image/png",
	});
	const orphanRecord = repository.get(orphan.attachmentId);
	if (!orphanRecord) {
		throw new Error("orphan attachment metadata missing");
	}
	const temporaryPath = `${join(root, orphanRecord.blobKey)}.crashed.tmp`;
	await writeFile(temporaryPath, PNG_BYTES);
	expect((await stat(temporaryPath)).size).toBe(PNG_BYTES.byteLength);
	repository.delete(orphan.attachmentId);
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
	expect(await stat(join(root, liveRecord.blobKey))).toBeTruthy();
});

test("validates magic bytes, size, cancellation, and bounded filenames", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const attachments = createConversationAttachmentStore({
		maxBytes: PNG_BYTES.byteLength,
		repository: createRepository(),
		root,
	});

	await expect(
		attachments.ingest({
			bytes: new Uint8Array([0xff, 0xd8, 0xff]),
			filename: "../unsafe\\name.png",
			mediaType: "image/png",
		})
	).rejects.toThrow("match");
	const controller = new AbortController();
	controller.abort();
	await expect(
		attachments.ingest(
			{
				bytes: PNG_BYTES,
				filename: "safe.png",
				mediaType: "image/png",
			},
			controller.signal
		)
	).rejects.toThrow();
	await expect(
		attachments.ingest({
			bytes: new Uint8Array([...PNG_BYTES, 0x02]),
			filename: "too-large.png",
			mediaType: "image/png",
		})
	).rejects.toThrow("smaller");

	const bounded = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "../unsafe\\name.png",
		mediaType: "image/png",
	});
	expect(bounded.filename.includes("/")).toBe(false);
	expect(bounded.filename.includes("\\")).toBe(false);
	expect(bounded.filename.length).toBeLessThanOrEqual(128);
});

test("annotates missing blobs without reading payload bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "wincode-attachments-"));
	const repository = createRepository();
	const attachments = createConversationAttachmentStore({ repository, root });
	const reference = await attachments.ingest({
		bytes: PNG_BYTES,
		filename: "missing.png",
		mediaType: "image/png",
	});
	const record = repository.get(reference.attachmentId);
	if (!record) {
		throw new Error("metadata was not written");
	}
	await unlink(join(root, record.blobKey));

	const annotated = await attachments.annotateMessagesForDisplay([
		{
			id: "user-1",
			parts: [attachmentReferenceToFilePart(reference)],
			role: "user",
		} as unknown as CodingAgentUIMessage,
	]);
	expect(annotated[0]?.parts[0]).toMatchObject({
		attachmentId: reference.attachmentId,
		displayAvailability: "missing",
	});
});

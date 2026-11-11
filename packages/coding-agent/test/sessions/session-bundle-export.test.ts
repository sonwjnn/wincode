import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceToFilePart } from "@/modules/sessions/attachment-reference";
import { createSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import type { SessionHostManager } from "@/modules/sessions/host/types";
import { createSessionUserMessage } from "@/modules/sessions/message";
import {
	createSessionBundleExportOperation,
	SessionBundleExportError,
} from "@/modules/sessions/session-bundle-export";
import type { SessionAttachmentStore } from "@/modules/sessions/storage/attachment-store";
import {
	createDrizzleAttachmentMetadataRepository,
	createSessionAttachmentStore,
} from "@/modules/sessions/storage/attachment-store";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
	resolveSessionLogFilePath,
} from "@/modules/sessions/storage/path";
import {
	parseSessionBundleManifest,
	SessionBundleValidationError,
	validateSessionBundleDirectory,
	validateSessionBundleLog,
} from "@/modules/sessions/storage/session-bundle";
import {
	createSessionLogEvent,
	decodeSessionLog,
	encodeSessionLogLine,
	SessionLogError,
} from "@/modules/sessions/storage/session-jsonl-codec";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import { toSessionId } from "@/shared/identifiers";
import {
	agentId,
	agentTurnId,
	compactionId,
	sessionMessageId,
} from "../support/identifiers";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const PNG_PREFIX = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const sha256 = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const temporaryRoots: string[] = [];

type ExportFixture = Readonly<{
	attachmentRoot: string;
	attachmentStore: SessionAttachmentStore;
	baseAttachmentStore: SessionAttachmentStore;
	close: () => Promise<void>;
	logRoot: string;
	manager: SessionHostManager;
	projectionSqlite: Readonly<{ exec: (sql: string) => void }>;
	root: string;
	setBeforeResolve: (action: (() => Promise<void>) | undefined) => void;
	store: SessionStore;
	workspace: string;
}>;

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => removeTemporaryDirectory(root))
	);
});

const createFixture = async (
	fileIo: SessionLogFileIo = {},
	onSessionDeletionWriterOperationEnqueued?: () => void
): Promise<ExportFixture> => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-session-bundle-")
	);
	temporaryRoots.push(root);
	const workspace = path.join(root, "workspace");
	const databasePath = path.join(root, "sessions.sqlite");
	await fs.mkdir(workspace, { recursive: true });
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const attachmentRoot = path.join(root, "attachments");
	const baseAttachmentStore = createSessionAttachmentStore({
		lifecycleRoot: logRoot,
		repository: createDrizzleAttachmentMetadataRepository(projection.db),
		root: attachmentRoot,
	});
	let beforeResolve: (() => Promise<void>) | undefined;
	const attachmentStore: SessionAttachmentStore = {
		...baseAttachmentStore,
		resolve: async (reference, signal) => {
			await beforeResolve?.();
			return await baseAttachmentStore.resolve(reference, signal);
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		attachmentRoot,
		attachmentStore,
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(
		projectionStore,
		logRoot,
		fileIo,
		onSessionDeletionWriterOperationEnqueued === undefined
			? undefined
			: { onSessionDeletionWriterOperationEnqueued }
	);
	const manager = createSessionHostManager();
	return {
		attachmentRoot,
		attachmentStore,
		baseAttachmentStore,
		close: async () => {
			await manager.shutdownAll();
			operational.sqlite.close();
			projection.sqlite.close();
		},
		logRoot,
		manager,
		projectionSqlite: projection.sqlite,
		root,
		setBeforeResolve: (action: (() => Promise<void>) | undefined) => {
			beforeResolve = action;
		},
		store,
		workspace,
	};
};

const createAttachment = async (
	fixture: ExportFixture,
	filename: string,
	marker: number
) =>
	await fixture.baseAttachmentStore.ingest({
		bytes: new Uint8Array([...PNG_PREFIX, marker]),
		filename,
		mediaType: "image/png",
	});

const createSessionWithRetainedAttachments = async (fixture: ExportFixture) => {
	const created = await fixture.store.createEmptySession({
		id: toSessionId("bundle-export-source"),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
	});
	if (created.writeOutcome.kind !== "committed") {
		throw new Error("The export fixture Session was not committed.");
	}
	const sessionId = created.id;
	const oldAttachment = await createAttachment(fixture, "old.png", 1);
	const compactionAttachment = await createAttachment(
		fixture,
		"summary.png",
		2
	);
	try {
		const firstMessageId = sessionMessageId("bundle-export-old-message");
		const keptMessageId = sessionMessageId("bundle-export-kept-message");
		for (const [messageId, text, attachment, turn] of [
			[
				firstMessageId,
				"The old retained record names an attachment.",
				oldAttachment.reference,
				"bundle-export-old-turn",
			],
			[
				keptMessageId,
				"The current record has no attachment.",
				undefined,
				"bundle-export-kept-turn",
			],
		] as const) {
			const message = createSessionUserMessage(
				text,
				undefined,
				[],
				attachment === undefined
					? []
					: [attachmentReferenceToFilePart(attachment)],
				messageId
			);
			const record = buildUserSessionRecord({
				agentId: agentId("build"),
				message,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(turn),
			});
			const outcome = await fixture.store.commitSessionRecord({
				record,
				sessionId,
			});
			if (outcome.kind !== "committed" || outcome.projection !== "ready") {
				throw new Error("The export fixture record was not projected.");
			}
		}
		const compaction = await fixture.store.appendCompaction({
			estimatedTokensAfter: 20,
			firstKeptUiMessageId: keptMessageId,
			id: compactionId("bundle-export-compaction"),
			sessionId,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				attachments: [
					{
						...compactionAttachment.reference,
						available: true,
						payloadOmitted: true,
					},
				],
				coveredMessageIds: [firstMessageId],
				formatVersion: 1,
				text: "The retained compaction references a second attachment.",
			},
			throughMessageUiId: firstMessageId,
			tokensBefore: 80,
			trigger: "threshold",
		});
		if (compaction.writeOutcome.kind !== "committed") {
			throw new Error("The export fixture compaction was not committed.");
		}
		return {
			attachments: [oldAttachment.reference, compactionAttachment.reference],
			sessionId,
		};
	} finally {
		await oldAttachment.release();
		await compactionAttachment.release();
	}
};

test("export bundles all retained record and compaction attachments with verified manifest checksums", async () => {
	const fixture = await createFixture();
	try {
		const { attachments, sessionId } =
			await createSessionWithRetainedAttachments(fixture);
		const destination = path.join(fixture.root, "portable-session");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);
		const result = await exportSession({
			destination,
			sessionId,
			sourceWorkspacePath: fixture.workspace,
		});
		const validated = await validateSessionBundleDirectory(destination);
		const logBytes = await Bun.file(
			path.join(destination, "session.jsonl")
		).bytes();
		const manifest = result.manifest;
		expect(manifest).toMatchObject({
			format: "wincode-session-bundle",
			version: 1,
			session: { id: sessionId },
			source: { workspacePath: fixture.workspace },
		});
		expect(manifest.sessionFile).toMatchObject({
			path: "session.jsonl",
			byteLength: logBytes.byteLength,
			sha256: sha256(logBytes),
		});
		expect(manifest.cut.sequence).toBeGreaterThan(2);
		expect(
			manifest.attachments.map(({ attachmentId }) => attachmentId).sort()
		).toEqual(attachments.map(({ attachmentId }) => attachmentId).sort());
		for (const attachment of manifest.attachments) {
			const bytes = await Bun.file(
				path.join(destination, attachment.path)
			).bytes();
			expect(attachment.sha256).toBe(sha256(bytes));
			expect(attachment.byteLength).toBe(bytes.byteLength);
		}
		expect(validated.session.logId).toBe(manifest.session.logId);
		expect(validated.cut).toEqual(manifest.cut);
	} finally {
		await fixture.close();
	}
});

test("export reports a missing Session log without creating a bundle", async () => {
	const fixture = await createFixture();
	try {
		const destination = path.join(fixture.root, "missing-session-export");
		const sessionId = toSessionId("bundle-export-missing");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);

		await expect(
			exportSession({ destination, sessionId })
		).rejects.toMatchObject({ code: "session_not_found", sessionId });
		await expect(fs.access(destination)).rejects.toBeDefined();
	} finally {
		await fixture.close();
	}
});

test("export refuses an existing destination without overwriting user data", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const destination = path.join(fixture.root, "already-there");
		await fs.mkdir(destination);
		await Bun.write(path.join(destination, "keep.txt"), "user data");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);
		await expect(
			exportSession({ destination, sessionId })
		).rejects.toMatchObject({
			code: "session_bundle_destination_exists",
		});
		expect(await Bun.file(path.join(destination, "keep.txt")).text()).toBe(
			"user data"
		);
	} finally {
		await fixture.close();
	}
});

test("atomic publish preserves an empty destination created after the preflight check", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const destination = path.join(fixture.root, "raced-empty-destination");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store,
			{
				beforePublish: async (_stagingPath, outputDirectory) => {
					expect(outputDirectory).toBe(destination);
					await fs.mkdir(outputDirectory);
				},
			}
		);

		await expect(
			exportSession({ destination, sessionId })
		).rejects.toMatchObject({
			code: "session_bundle_destination_exists",
		});
		expect(await fs.readdir(destination)).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("export refuses a Session Writer already held by active work instead of interrupting it", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const writer = await fixture.store.acquireSessionWriter(sessionId);
		try {
			const destination = path.join(fixture.root, "busy-export");
			const exportSession = createSessionBundleExportOperation(
				fixture.manager,
				fixture.store
			);
			await expect(
				exportSession({ destination, sessionId })
			).rejects.toMatchObject({
				code: "session_busy",
			});
			await expect(fs.access(destination)).rejects.toBeDefined();
		} finally {
			await writer.release();
		}
	} finally {
		await fixture.close();
	}
});

test("export refuses a blocked projection before publishing any bundle", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		fixture.projectionSqlite.exec(
			"UPDATE session_projection_state SET status = 'blocked' WHERE id = 1"
		);
		const destination = path.join(fixture.root, "blocked-projection-export");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);

		await expect(
			exportSession({ destination, sessionId })
		).rejects.toMatchObject({
			code: "session_projection_unavailable",
		});
		await expect(fs.access(destination)).rejects.toBeDefined();
	} finally {
		await fixture.close();
	}
});

test("export refuses an indeterminate log write before publishing any bundle", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const intentPath = path.join(
			fixture.root,
			"session-control",
			"indeterminate",
			`${sessionId}.json`
		);
		await fs.mkdir(path.dirname(intentPath), { recursive: true });
		await Bun.write(
			intentPath,
			JSON.stringify({
				expectedOffset: 1,
				operationDigest: "a".repeat(64),
				operationId: "pending-export-write",
				sequence: 2,
				sessionId,
				timestamp: "2026-10-31T12:00:00.000Z",
				type: "record.committed",
				version: 2,
			})
		);
		const destination = path.join(fixture.root, "indeterminate-export");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);

		await expect(
			exportSession({ destination, sessionId })
		).rejects.toMatchObject({
			code: "session_commit_indeterminate",
		});
		await expect(fs.access(destination)).rejects.toBeDefined();
	} finally {
		await fixture.close();
	}
});

test("source semantic corruption remains session_log_corrupt with its sequence and byte offset", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const sourceBytes = await Bun.file(
			resolveSessionLogFilePath(fixture.logRoot, sessionId)
		).bytes();
		const state = decodeSessionLog(sessionId, sourceBytes);
		const firstRecordEntry = state.entries.find(
			({ envelope }) => envelope.type === "record.committed"
		);
		const firstRecord = firstRecordEntry?.envelope.payload.record;
		const historyEntryId = firstRecordEntry?.envelope.payload.historyEntryId;
		if (
			firstRecordEntry === undefined ||
			firstRecord === null ||
			typeof firstRecord !== "object" ||
			typeof historyEntryId !== "string"
		) {
			throw new Error("The fixture has no committed Session Record.");
		}
		let parentEntryId: string | null = null;
		for (const { envelope } of state.entries) {
			if (
				envelope.type === "session.created" ||
				envelope.type === "record.committed" ||
				envelope.type === "plugin.state-replaced" ||
				envelope.type === "plugin.state-deleted"
			) {
				const activeLeafId = envelope.payload.activeLeafId;
				if (typeof activeLeafId === "string" || activeLeafId === null) {
					parentEntryId = activeLeafId;
				}
			}
		}
		if (parentEntryId === null) {
			throw new Error("The fixture has no current history leaf.");
		}
		const duplicate = createSessionLogEvent({
			operationId: "semantic-duplicate-record",
			payload: {
				activeLeafId: historyEntryId,
				historyEntryId,
				parentEntryId,
				record: firstRecord,
			},
			previousHash: state.lastHash,
			sequence: state.nextSequence,
			sessionId,
			timestamp: "2026-10-31T12:00:00.000Z",
			type: "record.committed",
		});
		const duplicateLine = encodeSessionLogLine(duplicate);
		const corruptBytes = new Uint8Array(
			sourceBytes.byteLength + duplicateLine.byteLength
		);
		corruptBytes.set(sourceBytes);
		corruptBytes.set(duplicateLine, sourceBytes.byteLength);

		let failure: unknown;
		try {
			validateSessionBundleLog(sessionId, corruptBytes, "source");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionLogError);
		expect(failure).toMatchObject({
			code: "session_log_corrupt",
			offset: sourceBytes.byteLength,
			sequence: state.nextSequence,
		});
		expect(() => validateSessionBundleLog(sessionId, corruptBytes)).toThrow(
			SessionBundleValidationError
		);
	} finally {
		await fixture.close();
	}
});

test("export reports sync-time source mutation with sequence and first changed byte", async () => {
	let mutateOnSync = false;
	let sourceLogFileName = "";
	let changedOffset = -1;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			await handle.sync();
			if (!mutateOnSync || path.basename(filePath) !== sourceLogFileName) {
				return;
			}
			mutateOnSync = false;
			const bytes = await Bun.file(filePath).bytes();
			changedOffset = bytes.byteLength - 2;
			bytes[changedOffset] = (bytes[changedOffset] ?? 0) === 0 ? 1 : 0;
			await Bun.write(filePath, bytes);
		},
	};
	const fixture = await createFixture(fileIo);
	try {
		const created = await fixture.store.createEmptySession({
			id: toSessionId("sync-race-export-session"),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The sync-race Session was not committed.");
		}
		const sessionId = created.id;
		sourceLogFileName = `${sessionId}.jsonl`;
		const sourceLogPath = resolveSessionLogFilePath(fixture.logRoot, sessionId);
		const sourceBytes = await Bun.file(sourceLogPath).bytes();
		const expectedOffset = sourceBytes.byteLength - 2;
		const expectedSequence =
			decodeSessionLog(sessionId, sourceBytes).nextSequence - 1;
		mutateOnSync = true;
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);

		await expect(
			exportSession({
				destination: path.join(fixture.root, "sync-race-export"),
				sessionId,
			})
		).rejects.toMatchObject({
			code: "session_log_corrupt",
			offset: expectedOffset,
			sequence: expectedSequence,
		});
		expect(changedOffset).toBe(expectedOffset);
	} finally {
		await fixture.close();
	}
});

test("export operation preserves source corruption diagnostics", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const sourceError = new SessionLogError(
			"session_log_corrupt",
			sessionId,
			"Session log contains a duplicate retained record identity.",
			{ offset: 123, sequence: 4 }
		);
		const withSessionBundleExport: NonNullable<
			SessionStore["withSessionBundleExport"]
		> = async () => {
			throw sourceError;
		};
		const exportSession = createSessionBundleExportOperation(fixture.manager, {
			...fixture.store,
			withSessionBundleExport,
		});

		await expect(
			exportSession({
				destination: path.join(fixture.root, "diagnostic-export"),
				sessionId,
			})
		).rejects.toMatchObject({
			code: "session_log_corrupt",
			offset: 123,
			reason: "Session log contains a duplicate retained record identity.",
			sequence: 4,
		});
	} finally {
		await fixture.close();
	}
});

test("export refuses corrupt authoritative history before publishing any bundle", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const logPath = resolveSessionLogFilePath(fixture.logRoot, sessionId);
		const bytes = await Bun.file(logPath).bytes();
		const corruptOffset = bytes.byteLength - 2;
		bytes[corruptOffset] = ((bytes.at(-2) ?? 0) + 1) % 256;
		await Bun.write(logPath, bytes);
		const destination = path.join(fixture.root, "corrupt-export");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);
		await expect(
			exportSession({ destination, sessionId })
		).rejects.toMatchObject({
			code: "session_log_corrupt",
		});
		await expect(fs.access(destination)).rejects.toBeDefined();
	} finally {
		await fixture.close();
	}
});

test("cancelled export removes staging output and releases attachment pins", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const started = Promise.withResolvers<void>();
		const continueCopy = Promise.withResolvers<void>();
		fixture.setBeforeResolve(async () => {
			started.resolve();
			await continueCopy.promise;
		});
		const controller = new AbortController();
		const destination = path.join(fixture.root, "cancelled-export");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);
		const exporting = exportSession({
			destination,
			sessionId,
			signal: controller.signal,
		});
		await started.promise;
		controller.abort(new Error("user cancelled export"));
		continueCopy.resolve();
		await expect(exporting).rejects.toBeInstanceOf(SessionBundleExportError);
		await expect(fs.access(destination)).rejects.toBeDefined();
		const siblings = await fs.readdir(fixture.root);
		expect(
			siblings.some((name) => name.includes("cancelled-export.staging"))
		).toBe(false);
		const pinDirectory = path.join(
			path.dirname(fixture.logRoot),
			"session-control",
			"attachment-pins"
		);
		const pins = await fs.readdir(pinDirectory).catch(() => []);
		expect(pins.filter((name) => name.endsWith(".json"))).toHaveLength(0);
	} finally {
		await fixture.close();
	}
});

test("Session deletion is serialized behind an in-flight export writer operation", async () => {
	const atPublish = Promise.withResolvers<void>();
	const resumePublish = Promise.withResolvers<void>();
	const deletionWriterOperationEnqueued = Promise.withResolvers<void>();
	const fixture = await createFixture({}, () =>
		deletionWriterOperationEnqueued.resolve()
	);
	let exporting: Promise<unknown> | undefined;
	let deleting: Promise<unknown> | undefined;
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const destination = path.join(fixture.root, "delete-race-export");
		const completionOrder: string[] = [];
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store,
			{
				beforePublish: async () => {
					atPublish.resolve();
					await resumePublish.promise;
				},
			}
		);
		exporting = exportSession({ destination, sessionId }).then((outcome) => {
			completionOrder.push("export");
			return outcome;
		});
		await atPublish.promise;
		let deletionCompleted = false;
		deleting = fixture.store.deleteSession(sessionId).then((outcome) => {
			deletionCompleted = true;
			completionOrder.push("delete");
			return outcome;
		});
		await deletionWriterOperationEnqueued.promise;
		expect(deletionCompleted).toBe(false);
		resumePublish.resolve();
		expect(await exporting).toMatchObject({ status: "exported" });
		expect(await deleting).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(completionOrder).toEqual(["export", "delete"]);
		expect((await validateSessionBundleDirectory(destination)).session.id).toBe(
			sessionId
		);
	} finally {
		resumePublish.resolve();
		await Promise.allSettled(
			[exporting, deleting].filter(
				(promise): promise is Promise<unknown> => promise !== undefined
			)
		);
		await fixture.close();
	}
});

test("GC cannot reclaim closure blobs while export copies pinned source attachments", async () => {
	const fixture = await createFixture();
	const continueCopy = Promise.withResolvers<void>();
	let exporting: Promise<unknown> | undefined;
	try {
		const { attachments, sessionId } =
			await createSessionWithRetainedAttachments(fixture);
		const started = Promise.withResolvers<void>();
		fixture.setBeforeResolve(async () => {
			started.resolve();
			await continueCopy.promise;
		});
		const destination = path.join(fixture.root, "gc-race-export");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		);
		exporting = exportSession({ destination, sessionId });
		await started.promise;
		const sourceLogPath = resolveSessionLogFilePath(fixture.logRoot, sessionId);
		await fs.rename(
			sourceLogPath,
			path.join(fixture.root, "hidden-source-log.jsonl")
		);
		const pinDirectory = path.join(
			path.dirname(fixture.logRoot),
			"session-control",
			"attachment-pins"
		);
		const pins = await fs.readdir(pinDirectory);
		expect(pins.filter((name) => name.endsWith(".json"))).toHaveLength(
			attachments.length
		);
		const report = await fixture.attachmentStore.collect({
			liveAttachmentIds: [],
			maxBytes: Number.MAX_SAFE_INTEGER,
			maxEntries: Number.MAX_SAFE_INTEGER,
			safetyWindowMs: 0,
		});
		expect(report.reclaimedCount).toBe(0);
		for (const attachment of attachments) {
			const resolution = await fixture.baseAttachmentStore.resolve(attachment);
			expect(resolution.availability).toBe("available");
		}
		continueCopy.resolve();
		await exporting;
	} finally {
		continueCopy.resolve();
		if (exporting !== undefined) {
			await Promise.allSettled([exporting]);
		}
		await fixture.close();
	}
});

test("a process crash before atomic publication leaves only an unpublished staging directory", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-session-bundle-crash-")
	);
	temporaryRoots.push(root);
	const workerPath = path.resolve(
		import.meta.dir,
		"../support/session-bundle-export-crash-worker.ts"
	);
	const worker = Bun.spawn([process.execPath, workerPath, root], {
		cwd: path.resolve(import.meta.dir, "../.."),
		stderr: "ignore",
		stdout: "ignore",
	});

	expect(await worker.exited).toBe(73);
	const destination = path.join(root, "crash-bundle");
	await expect(fs.access(destination)).rejects.toBeDefined();
	const staging = (await fs.readdir(root)).find((name) =>
		name.startsWith("crash-bundle.staging-")
	);
	expect(staging).toBeDefined();
	if (staging === undefined) {
		throw new Error("The crashed export left no staging directory to inspect.");
	}
	const stagedFiles = await fs.readdir(path.join(root, staging));
	expect(stagedFiles).toContain("manifest.json");
	expect(stagedFiles).toContain("session.jsonl");
});

test("a failed pre-publication attempt leaves the destination absent and removes staging", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const destination = path.join(fixture.root, "crashed-publish");
		const exportSession = createSessionBundleExportOperation(
			fixture.manager,
			fixture.store,
			{
				beforePublish: async () => {
					throw new Error("simulated process failure before atomic rename");
				},
			}
		);
		await expect(
			exportSession({ destination, sessionId })
		).rejects.toBeDefined();
		await expect(fs.access(destination)).rejects.toBeDefined();
		const siblings = await fs.readdir(fixture.root);
		expect(
			siblings.some((name) => name.includes("crashed-publish.staging"))
		).toBe(false);
	} finally {
		await fixture.close();
	}
});

test("bundle validation refuses symlinked members instead of following files outside the bundle", async () => {
	const fixture = await createFixture();
	try {
		const { sessionId } = await createSessionWithRetainedAttachments(fixture);
		const destination = path.join(fixture.root, "symlinked-bundle");
		await createSessionBundleExportOperation(
			fixture.manager,
			fixture.store
		)({
			destination,
			sessionId,
		});
		const logPath = path.join(destination, "session.jsonl");
		await fs.rm(logPath);
		await fs.symlink(
			resolveSessionLogFilePath(fixture.logRoot, sessionId),
			logPath
		);

		await expect(
			validateSessionBundleDirectory(destination)
		).rejects.toMatchObject({
			code: "session_bundle_invalid",
		});
	} finally {
		await fixture.close();
	}
});

test("bundle validation reports missing directories as invalid bundle input", async () => {
	const parent = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-bundle-validator-")
	);
	temporaryRoots.push(parent);

	await expect(
		validateSessionBundleDirectory(path.join(parent, "missing-bundle"))
	).rejects.toMatchObject({ code: "session_bundle_invalid" });
});

test("bundle manifest validation rejects a log ID ending in a line terminator", () => {
	const manifest = {
		attachments: [],
		cut: { hash: "a".repeat(64), sequence: 1 },
		format: "wincode-session-bundle",
		session: { id: "bundle-source", logId: "source-log\n" },
		sessionFile: {
			byteLength: 0,
			path: "session.jsonl",
			sha256: "b".repeat(64),
		},
		version: 1,
	};
	expect(() => parseSessionBundleManifest(manifest)).toThrow(
		SessionBundleValidationError
	);
});

test("bundle manifest validation rejects path traversal before reading outside the bundle", () => {
	const invalidManifest = {
		attachments: [],
		cut: { hash: "a".repeat(64), sequence: 1 },
		format: "wincode-session-bundle",
		session: { id: "bundle-source", logId: "source-log" },
		sessionFile: {
			byteLength: 0,
			path: "../outside.jsonl",
			sha256: "b".repeat(64),
		},
		version: 1,
	};
	expect(() => parseSessionBundleManifest(invalidManifest)).toThrow();
});

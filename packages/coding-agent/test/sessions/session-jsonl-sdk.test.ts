import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionSdk } from "@wincode/coding-agent";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceToFilePart } from "@/modules/sessions/attachment-reference";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import type {
	SessionSdkHandle,
	SessionSdkSnapshot,
} from "@/modules/sessions/sdk-contract";
import {
	createMemoryAttachmentMetadataRepository,
	createSessionAttachmentStore,
} from "@/modules/sessions/storage/attachment-store";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "@/modules/sessions/storage/path";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import { type SessionId, toSessionId } from "@/shared/identifiers";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import {
	agentId,
	agentTurnId,
	compactionId,
	modelId,
	sessionMessageId,
} from "../support/identifiers";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-session-jsonl-"));
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });

afterAll(async () => {
	await fs.rm(root, { force: true, recursive: true });
});

test("public SDK returns an empty Session only after its v1 JSONL log is published", async () => {
	const databasePath = path.join(root, "sdk-empty-session.sqlite");
	const sdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});

	try {
		const sessionId = await sdk.createEmptySession();
		const logPath = path.join(root, "session-logs", sessionId, "session.jsonl");
		const bytes = await fs.readFile(logPath);
		const text = new TextDecoder().decode(bytes);
		const lines = text.split("\n");
		const header = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
		const created = JSON.parse(lines[1] ?? "null") as Record<string, unknown>;

		expect(text.endsWith("\n")).toBe(true);
		expect(header).toMatchObject({
			formatVersion: 1,
			sessionId,
			sequence: 0,
			type: "session.header",
			previousHash: null,
		});
		expect(typeof header.operationId).toBe("string");
		expect(typeof header.entryHash).toBe("string");
		expect(created).toMatchObject({
			formatVersion: 1,
			sessionId,
			sequence: 1,
			type: "session.created",
		});
		expect(created.previousHash).toBe(header.entryHash);
	} finally {
		await sdk.dispose();
	}
});

test("retrying the same Session creation identity does not append a duplicate checkpoint", async () => {
	const databasePath = path.join(root, "sdk-create-retry.sqlite");
	const sdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	try {
		const sessionId = await sdk.createEmptySession();
		const retriedId = await sdk.createEmptySession({ sessionId });
		await expect(
			sdk.createEmptySession({ sessionId, thinkingLevel: "high" })
		).rejects.toMatchObject({ code: "session_operation_conflict" });
		const logPath = path.join(root, "session-logs", sessionId, "session.jsonl");
		const entries = (await fs.readFile(logPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { sequence: number; type: string });

		expect(retriedId).toBe(sessionId);
		expect(entries.map(({ sequence, type }) => [sequence, type])).toEqual([
			[0, "session.header"],
			[1, "session.created"],
		]);
	} finally {
		await sdk.dispose();
	}
});

test("the Session projection stays out of the operational SQLite database", async () => {
	const databasePath = path.join(root, "sdk-split-databases.sqlite");
	const sdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let sessionId: string | undefined;
	try {
		sessionId = await sdk.createEmptySession();
	} finally {
		await sdk.dispose();
	}

	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	try {
		const operationalSessionCount = operational.sqlite
			.query("SELECT COUNT(*) AS count FROM session")
			.get() as { count: number };
		const operationalBindingCount = operational.sqlite
			.query(
				"SELECT COUNT(*) AS count FROM local_session_binding WHERE session_id = ?"
			)
			.get(sessionId) as { count: number };
		const projectionSessionCount = projection.sqlite
			.query("SELECT COUNT(*) AS count FROM session WHERE id = ?")
			.get(sessionId) as { count: number };

		expect(operationalSessionCount.count).toBe(0);
		expect(operationalBindingCount.count).toBe(1);
		expect(projectionSessionCount.count).toBe(1);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("attachment collection is blocked when the log is ahead of its projection", async () => {
	const testDirectory = path.join(root, "attachment-gc");
	await fs.mkdir(testDirectory, { recursive: true });
	const databasePath = path.join(testDirectory, "sdk-attachment-gc.sqlite");
	const logRoot = path.join(testDirectory, "attachment-gc-logs");
	const attachmentRoot = path.join(testDirectory, "attachment-gc-blobs");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const attachments = createSessionAttachmentStore({
		repository: createMemoryAttachmentMetadataRepository(),
		root: attachmentRoot,
	});
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			attachmentRoot,
			attachmentStore: attachments,
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const sessionId = toSessionId("attachment-gc-session");
	const reference = await attachments.ingest({
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		filename: "referenced.png",
		mediaType: "image/png",
	});
	try {
		await store.createEmptySession({ id: sessionId });
		projection.sqlite.exec(`
			CREATE TRIGGER reject_attachment_record_projection
			BEFORE INSERT ON session_record
			BEGIN
				SELECT RAISE(ABORT, 'injected projection failure');
			END;
		`);
		const outcome = await store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("build"),
				message: {
					id: sessionMessageId("attachment-gc-user"),
					parts: [
						{ text: "keep this attachment", type: "text" },
						attachmentReferenceToFilePart(reference),
					],
					role: "user",
				},
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("attachment-gc-turn"),
			}),
			sessionId,
		});
		expect(outcome).toMatchObject({ kind: "committed", projection: "blocked" });
		await expect(store.collectAttachments(0)).rejects.toThrow(
			"Attachment collection is blocked"
		);
		await expect(attachments.resolve(reference)).resolves.toMatchObject({
			availability: "available",
		});
	} finally {
		projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_attachment_record_projection"
		);
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("the Session catalog reports one corrupt log without hiding healthy Sessions", async () => {
	const databasePath = path.join(root, "sdk-catalog-corruption.sqlite");
	const logRoot = path.join(root, "catalog-corruption-logs");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const healthyId = toSessionId("catalog-healthy-session");
	const corruptId = toSessionId("catalog-corrupt-session");

	try {
		await store.createEmptySession({ id: healthyId });
		await store.createEmptySession({ id: corruptId });
		const corruptLogPath = path.join(corruptId, "session.jsonl");
		const logPath = path.join(logRoot, corruptLogPath);
		const lines = (await fs.readFile(logPath, "utf8")).split("\n");
		const header = JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
		header.formatVersion = 2;
		lines[0] = JSON.stringify(header);
		await fs.writeFile(logPath, lines.join("\n"));

		const catalog = await store.listSessionCatalog();
		expect(catalog.sessions.map(({ id }) => id)).toContain(healthyId);
		expect(catalog.sessions.map(({ id }) => id)).not.toContain(corruptId);
		expect(catalog.issues).toContainEqual({
			code: "session_log_version_unsupported",
			message: expect.any(String),
			sessionId: corruptId,
		});
		await expect(store.listSessionRecords(healthyId)).resolves.toHaveLength(0);
		await expect(store.getSession(corruptId)).rejects.toMatchObject({
			code: "session_log_version_unsupported",
		});
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("separate stores cannot bypass an existing same-process Session Writer lock", async () => {
	const databasePath = path.join(root, "sdk-same-process-lock.sqlite");
	const logRoot = path.join(root, "same-process-lock-logs");
	const sessionId = toSessionId("same-process-lock-session");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const firstStore = createSessionJsonlStore(projectionStore, logRoot);
	const secondStore = createSessionJsonlStore(projectionStore, logRoot);

	try {
		await firstStore.createEmptySession({ id: sessionId });
		const writer = await firstStore.acquireSessionWriter(sessionId);
		try {
			expect(
				await secondStore.updateSession(sessionId, {
					operationId: "second-store-lock-contender",
					title: "Must wait for the Session Writer.",
				})
			).toMatchObject({
				kind: "not-committed",
				error: { code: "session_in_use" },
				operationId: "second-store-lock-contender",
			});
		} finally {
			await writer.release();
		}

		expect(
			await secondStore.updateSession(sessionId, {
				operationId: "second-store-lock-contender",
				title: "Must wait for the Session Writer.",
			})
		).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("a concurrent catch-up cannot turn an already projected durable record into a blocked write", async () => {
	const databasePath = path.join(root, "sdk-projection-cursor-race.sqlite");
	const logRoot = path.join(root, "projection-cursor-race-logs");
	const sessionId = toSessionId("projection-cursor-race-session");
	const operational = createDatabase(databasePath);
	const secondOperational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const secondProjection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const firstProjectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const secondProjectionStore = createDrizzleSessionStore(secondProjection.db, {
		operationalDatabase: secondOperational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	let replayedConcurrentEntry = false;
	let secondStore: SessionStore;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			await handle.sync();
			if (
				!replayedConcurrentEntry &&
				filePath.endsWith(path.join(sessionId, "session.jsonl"))
			) {
				replayedConcurrentEntry = true;
				await secondStore.getSession(sessionId);
			}
		},
	};
	const firstStore = createSessionJsonlStore(
		firstProjectionStore,
		logRoot,
		fileIo
	);
	secondStore = createSessionJsonlStore(secondProjectionStore, logRoot);

	try {
		await secondStore.createEmptySession({ id: sessionId });
		const message = {
			id: sessionMessageId("projection-cursor-race-message"),
			parts: [
				{
					text: "Replay this concurrently committed record.",
					type: "text" as const,
				},
			],
			role: "user" as const,
		};
		const record = buildUserSessionRecord({
			agentId: agentId("build"),
			message,
			model: {
				modelId: modelId("projection-race-model"),
				providerId: "test-provider",
			},
			turnId: agentTurnId("projection-cursor-race-turn"),
		});

		await firstStore.commitSessionRecord({ record, sessionId });

		expect(replayedConcurrentEntry).toBe(true);
		expect(
			(await secondStore.listSessionRecords(sessionId)).filter(
				(entry) => entry.id === record.id
			)
		).toHaveLength(1);
	} finally {
		operational.sqlite.close();
		secondOperational.sqlite.close();
		projection.sqlite.close();
		secondProjection.sqlite.close();
	}
});

test("a concurrent read reconciling a write marker does not block the writer", async () => {
	const databasePath = path.join(root, "sdk-write-marker-race.sqlite");
	const logRoot = path.join(root, "write-marker-race-logs");
	const sessionId = toSessionId("write-marker-race-session");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const writerPaused = Promise.withResolvers<void>();
	const releaseWriter = Promise.withResolvers<void>();
	let pauseAtMarkerClear = false;
	let hasPaused = false;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			await handle.sync();
			if (
				pauseAtMarkerClear &&
				!hasPaused &&
				filePath.endsWith(path.join("indeterminate", `${sessionId}.json`))
			) {
				hasPaused = true;
				writerPaused.resolve();
				await releaseWriter.promise;
			}
		},
	};
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot,
		fileIo
	);
	const record = buildUserSessionRecord({
		agentId: agentId("build"),
		message: {
			id: sessionMessageId("write-marker-race-message"),
			parts: [{ text: "A concurrent projection read is safe.", type: "text" }],
			role: "user",
		},
		model: {
			modelId: modelId("write-marker-race-model"),
			providerId: "test-provider",
		},
		turnId: agentTurnId("write-marker-race-turn"),
	});

	try {
		await store.createEmptySession({ id: sessionId });
		pauseAtMarkerClear = true;
		const writing = store.commitSessionRecord({ record, sessionId });
		try {
			await writerPaused.promise;
			await expect(store.getSession(sessionId)).resolves.toBeDefined();
			releaseWriter.resolve();
			expect(await writing).toMatchObject({
				kind: "committed",
				projection: "ready",
			});
			expect(await store.listSessionRecords(sessionId)).toHaveLength(1);
		} finally {
			releaseWriter.resolve();
			await writing.catch(() => undefined);
		}
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("two concurrent replay readers reload when one advances the projection cursor", async () => {
	const databasePath = path.join(root, "sdk-two-projectors.sqlite");
	const logRoot = path.join(root, "two-projectors-logs");
	const firstOperational = createDatabase(databasePath);
	const secondOperational = createDatabase(databasePath);
	const firstProjection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const secondProjection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("two-projectors-session");
	let raceArmed = false;
	let readersAtBarrier = 0;
	const bothReaders = Promise.withResolvers<void>();
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			await handle.sync();
			if (
				raceArmed &&
				filePath.endsWith(path.join(sessionId, "session.jsonl"))
			) {
				readersAtBarrier += 1;
				if (readersAtBarrier === 2) {
					bothReaders.resolve();
				}
				await bothReaders.promise;
			}
		},
	};
	const firstStore = createSessionJsonlStore(
		createDrizzleSessionStore(firstProjection.db, {
			operationalDatabase: firstOperational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot,
		fileIo
	);
	const secondStore = createSessionJsonlStore(
		createDrizzleSessionStore(secondProjection.db, {
			operationalDatabase: secondOperational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot,
		fileIo
	);
	const record = buildUserSessionRecord({
		agentId: agentId("build"),
		message: {
			id: sessionMessageId("two-projectors-message"),
			parts: [{ text: "Replay exactly once.", type: "text" }],
			role: "user",
		},
		model: {
			modelId: modelId("two-projectors-model"),
			providerId: "test-provider",
		},
		turnId: agentTurnId("two-projectors-turn"),
	});

	try {
		await firstStore.createEmptySession({ id: sessionId });
		firstProjection.sqlite.exec(`
			CREATE TRIGGER reject_two_projector_record
			BEFORE UPDATE ON session
			BEGIN
				SELECT RAISE(ABORT, 'injected first projection failure');
			END;
		`);
		expect(
			await firstStore.commitSessionRecord({ record, sessionId })
		).toMatchObject({
			kind: "committed",
			projection: "blocked",
		});
		firstProjection.sqlite.exec("DROP TRIGGER reject_two_projector_record");
		raceArmed = true;

		const [first, second] = await Promise.all([
			firstStore.getSession(sessionId),
			secondStore.getSession(sessionId),
		]);
		raceArmed = false;
		expect(first.id).toBe(sessionId);
		expect(second.id).toBe(sessionId);
		expect(
			(await firstStore.listSessionRecords(sessionId)).filter(
				(entry) => entry.id === record.id
			)
		).toHaveLength(1);
		expect(
			(await secondStore.listSessionRecords(sessionId)).filter(
				(entry) => entry.id === record.id
			)
		).toHaveLength(1);
		expect(readersAtBarrier).toBe(2);
	} finally {
		firstProjection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_two_projector_record"
		);
		firstOperational.sqlite.close();
		secondOperational.sqlite.close();
		firstProjection.sqlite.close();
		secondProjection.sqlite.close();
	}
});

test("Workspace listing skips JSONL Sessions bound to another Workspace", async () => {
	const databasePath = path.join(root, "sdk-workspace-isolation.sqlite");
	const logRoot = path.join(root, "workspace-isolation-logs");
	const otherWorkspace = path.join(root, "other-workspace");
	await fs.mkdir(otherWorkspace, { recursive: true });
	const firstOperational = createDatabase(databasePath);
	const secondOperational = createDatabase(databasePath);
	const firstProjection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const secondProjection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const firstStore = createSessionJsonlStore(
		createDrizzleSessionStore(firstProjection.db, {
			operationalDatabase: firstOperational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const secondStore = createSessionJsonlStore(
		createDrizzleSessionStore(secondProjection.db, {
			operationalDatabase: secondOperational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: otherWorkspace,
		}),
		logRoot
	);
	const sessionId = toSessionId("workspace-isolation-session");

	try {
		await firstStore.createEmptySession({ id: sessionId });

		expect(await secondStore.listSessions()).toEqual([]);
		await expect(secondStore.getSession(sessionId)).rejects.toThrow(
			"Session not found"
		);
		expect(
			(await secondStore.createEmptySession({ id: sessionId })).writeOutcome
		).toMatchObject({
			kind: "not-committed",
			error: { code: "session_not_found", message: "Session not found" },
		});
		expect((await firstStore.getSession(sessionId)).id).toBe(sessionId);
		expect(
			(
				await fs.readFile(
					path.join(logRoot, sessionId, "session.jsonl"),
					"utf8"
				)
			)
				.trimEnd()
				.split("\n")
		).toHaveLength(2);
	} finally {
		firstOperational.sqlite.close();
		secondOperational.sqlite.close();
		firstProjection.sqlite.close();
		secondProjection.sqlite.close();
	}
});

test("SDK creation stores its initial chat text in the creation checkpoint before reopen", async () => {
	const databasePath = path.join(root, "sdk-initial-chat.sqlite");
	const sdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let created: SessionSdkHandle | undefined;
	let reopened: SessionSdkHandle | undefined;

	try {
		created = await sdk.createSession({
			initialPrompt: "Keep this input in the creation checkpoint.",
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		const sessionId = created.sessionId;
		const logPath = path.join(root, "session-logs", sessionId, "session.jsonl");
		const lines = (await fs.readFile(logPath, "utf8")).trimEnd().split("\n");
		const entries = lines.map(
			(line) => JSON.parse(line) as Record<string, unknown>
		);
		const createdEntry = entries.find(
			(entry) => entry.type === "session.created"
		);
		const payload = createdEntry?.payload as {
			initialRecord?: {
				messages?: Array<{ parts?: Array<{ text?: string }> }>;
			};
		};

		expect(payload.initialRecord?.messages?.[0]?.parts?.[0]?.text).toBe(
			"Keep this input in the creation checkpoint."
		);
		expect(
			entries.filter((entry) => entry.type === "record.committed")
		).toHaveLength(0);

		await created.dispose();
		created = undefined;
		reopened = await sdk.openSession(sessionId, { autoContinue: false });
		let restoredText = false;
		const unsubscribe = reopened.subscribe(({ transcript }) => {
			restoredText = transcript.some(
				(message) =>
					JSON.stringify(message)?.includes(
						"Keep this input in the creation checkpoint."
					) ?? false
			);
		});
		unsubscribe();
		expect(restoredText).toBe(true);
	} finally {
		await created?.dispose();
		await reopened?.dispose();
		await sdk.dispose();
	}
});

test("retrying initial SDK input with the same Session ID is a creation no-op", async () => {
	const databasePath = path.join(root, "sdk-initial-retry.sqlite");
	const sessionId = toSessionId("initial-retry-session");
	const firstSdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	try {
		const first = await firstSdk.createSession({
			initialPrompt: "Retry this creation input.",
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId,
		});
		await first.dispose();
	} finally {
		await firstSdk.dispose();
	}

	const retrySdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	try {
		const retried = await retrySdk.createSession({
			initialPrompt: "Retry this creation input.",
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId,
		});
		const entries = (
			await fs.readFile(
				path.join(root, "session-logs", sessionId, "session.jsonl"),
				"utf8"
			)
		)
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });

		expect(
			entries.filter(({ type }) => type === "session.created")
		).toHaveLength(1);
		await retried.dispose();
	} finally {
		await retrySdk.dispose();
	}
});

test("a creation sync failure is tagged not committed and publishes no log", async () => {
	const databasePath = path.join(root, "sdk-create-sync-fault.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("create-sync-fault-session");
	const logRoot = path.join(root, "create-sync-fault-logs");
	const fileIo: SessionLogFileIo = {
		sync: async (_filePath, handle) => {
			await handle.sync();
			throw new Error("injected creation sync failure");
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);

	try {
		const creation = await store.createEmptySession({ id: sessionId });
		expect(creation.writeOutcome).toMatchObject({
			kind: "not-committed",
			operationId: `create-${sessionId}`,
			error: { code: "session_log_write_not_committed" },
		});
		await expect(
			fs.stat(path.join(logRoot, sessionId, "session.jsonl"))
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(await projectionStore.listSessions()).toEqual([]);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("retry reconciles a published Session creation after sync verification fails", async () => {
	const databasePath = path.join(root, "sdk-create-published-fault.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("create-published-fault-session");
	const logRoot = path.join(root, "create-published-fault-logs");
	await fs.mkdir(logRoot, { recursive: true });
	const logPath = path.join(
		await fs.realpath(logRoot),
		sessionId,
		"session.jsonl"
	);
	let failPublishedSync = true;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			await handle.sync();
			if (filePath === logPath && failPublishedSync) {
				failPublishedSync = false;
				throw new Error("injected published creation sync failure");
			}
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);

	try {
		const uncertain = await store.createEmptySession({ id: sessionId });
		expect(uncertain.writeOutcome).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
		});
		expect((await store.getSession(sessionId)).title).toBe("Untitled Session");
		const recovered = await store.createEmptySession({ id: sessionId });
		expect(recovered.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(await projectionStore.listSessions()).toHaveLength(1);
		const entries = (await fs.readFile(logPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(
			entries.filter(({ type }) => type === "session.created")
		).toHaveLength(1);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("same-operation retry reconciles a durable log entry after sync verification fails", async () => {
	const databasePath = path.join(root, "sdk-sync-fault.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("sync-fault-session");
	const logRoot = path.join(root, "sync-fault-logs");
	let logPath: string | undefined;
	let logSyncCount = 0;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			if (filePath === logPath) {
				logSyncCount += 1;
				if (logSyncCount === 2) {
					throw new Error("injected log sync failure");
				}
			}
			await handle.sync();
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);

	try {
		await store.createEmptySession({ id: sessionId });
		logPath = path.join(await fs.realpath(logRoot), sessionId, "session.jsonl");
		const uncertain = await store.updateSession(sessionId, {
			title: "Recovered title",
		});
		expect(uncertain).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
			requiresReconciliation: true,
		});
		expect((await store.getSession(sessionId)).title).toBe("Recovered title");
		if (uncertain.kind !== "indeterminate") {
			throw new Error("The injected sync failure was not indeterminate.");
		}
		const recovered = await store.updateSession(sessionId, {
			operationId: uncertain.operationId,
			title: "Recovered title",
		});
		expect(recovered).toMatchObject({
			kind: "committed",
			operationId: uncertain.operationId,
			projection: "ready",
		});
		expect((await store.getSession(sessionId)).title).toBe("Recovered title");
		const log = (await fs.readFile(logPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { operationId: string });
		expect(
			log.filter(({ operationId }) => operationId === uncertain.operationId)
		).toHaveLength(1);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("same-operation retry repairs a partial durable receipt from the committed log", async () => {
	const databasePath = path.join(root, "sdk-partial-receipt.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("partial-receipt-session");
	const logRoot = path.join(root, "partial-receipt-logs");
	let failReceiptWrite = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (failReceiptWrite && filePath.endsWith(`${operationId}.json`)) {
				failReceiptWrite = false;
				await handle.write(bytes, offset, Math.min(length, 8), position);
				throw new Error("injected partial receipt write");
			}
			return (await handle.write(bytes, offset, length, position)).bytesWritten;
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);
	const record = buildUserSessionRecord({
		agentId: agentId("build"),
		message: {
			id: sessionMessageId("partial-receipt-message"),
			parts: [{ text: "recover the durable receipt", type: "text" }],
			role: "user",
		},
		model: {
			modelId: modelId("partial-receipt-model"),
			providerId: "test-provider",
		},
		turnId: agentTurnId("partial-receipt-turn"),
	});
	const operationId = `record-${record.id}`;

	try {
		await store.createEmptySession({ id: sessionId });
		failReceiptWrite = true;
		const uncertain = await store.commitSessionRecord({ record, sessionId });
		expect(uncertain).toMatchObject({
			kind: "committed",
			projection: "blocked",
		});
		const recovered = await store.commitSessionRecord({ record, sessionId });
		expect(recovered).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(await store.listSessionRecords(sessionId)).toHaveLength(1);
		const receiptPath = path.join(
			path.dirname(await fs.realpath(logRoot)),
			"session-control",
			"receipts",
			sessionId,
			`${operationId}.json`
		);
		const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as {
			entryHash: string;
			operationId: string;
			sessionId: string;
		};
		expect(receipt).toMatchObject({
			entryHash: expect.any(String),
			operationId,
			sessionId,
		});
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("failure to persist the write intent leaves JSONL untouched and readable", async () => {
	const databasePath = path.join(root, "sdk-write-intent-fault.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("write-intent-fault-session");
	const logRoot = path.join(root, "write-intent-fault-logs");
	let failIntentSync = false;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			if (
				failIntentSync &&
				filePath.includes(`${path.sep}indeterminate${path.sep}`)
			) {
				throw new Error("injected intent sync failure");
			}
			await handle.sync();
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);

	try {
		await store.createEmptySession({ id: sessionId });
		const logPath = path.join(logRoot, sessionId, "session.jsonl");
		const before = await fs.readFile(logPath);
		failIntentSync = true;
		const outcome = await store.updateSession(sessionId, {
			operationId: "intent-sync-failure",
			title: "Must not append",
		});
		expect(outcome).toMatchObject({
			kind: "not-committed",
			error: { code: "session_log_write_not_committed" },
		});
		expect(await fs.readFile(logPath)).toEqual(before);
		expect((await store.getSession(sessionId)).title).toBe("Untitled Session");
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("same-operation retry quarantines and repairs an incomplete JSONL suffix", async () => {
	const databasePath = path.join(root, "sdk-partial-write.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("partial-write-session");
	const logRoot = path.join(root, "partial-write-logs");
	let logPath: string | undefined;
	let injectedPartialWrite = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (filePath === logPath && !injectedPartialWrite) {
				injectedPartialWrite = true;
				const partialLength = Math.min(23, length);
				await handle.write(bytes, offset, partialLength, position + offset);
				throw new Error("injected partial JSONL write");
			}
			return (await handle.write(bytes, offset, length, position + offset))
				.bytesWritten;
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);
	const operationId = "partial-append-retry";

	try {
		await store.createEmptySession({ id: sessionId });
		logPath = path.join(await fs.realpath(logRoot), sessionId, "session.jsonl");
		const uncertain = await store.updateSession(sessionId, {
			operationId,
			title: "Recovered after truncation",
		});
		expect(uncertain).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
		});
		await expect(store.getSession(sessionId)).rejects.toMatchObject({
			code: "session_log_write_indeterminate",
		});

		const recovered = await store.updateSession(sessionId, {
			operationId,
			title: "Recovered after truncation",
		});
		expect(recovered).toMatchObject({
			kind: "committed",
			operationId,
			projection: "ready",
		});
		expect((await store.getSession(sessionId)).title).toBe(
			"Recovered after truncation"
		);
		const quarantined = await fs.readFile(
			path.join(
				root,
				"session-control",
				"quarantine",
				sessionId,
				`2-${operationId}.partial`
			)
		);
		expect(quarantined.byteLength).toBeGreaterThan(0);
		expect(quarantined.at(-1)).not.toBe(0x0a);
		const entries = (await fs.readFile(logPath, "utf8"))
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { operationId: string });
		expect(
			entries.filter((entry) => entry.operationId === operationId)
		).toHaveLength(1);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("a durable log commit reports its receipt when SQLite projection fails", async () => {
	const databasePath = path.join(root, "sdk-projection-fault.sqlite");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("projection-fault-session");
	const logRoot = path.join(root, "projection-fault-logs");
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot);

	try {
		await store.createEmptySession({ id: sessionId });
		projection.sqlite.exec(`
			CREATE TRIGGER reject_session_projection_update
			BEFORE UPDATE ON session
			BEGIN
				SELECT RAISE(ABORT, 'injected projection failure');
			END;
		`);
		const outcome = await store.updateSession(sessionId, {
			operationId: "metadata-fault-retry",
			title: "Durably committed",
		});
		expect(outcome).toMatchObject({
			kind: "committed",
			projection: "blocked",
			sequence: 2,
		});

		projection.sqlite.exec("DROP TRIGGER reject_session_projection_update");
		await store.updateSession(sessionId, {
			operationId: "metadata-fault-retry",
			title: "Durably committed",
		});
		expect((await store.getSession(sessionId)).title).toBe("Durably committed");
		const entries = (
			await fs.readFile(path.join(logRoot, sessionId, "session.jsonl"), "utf8")
		)
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(
			entries.filter(({ type }) => type === "session.metadata-updated")
		).toHaveLength(1);
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("public SDK reports a committed-but-blocked prompt without scheduling model work", async () => {
	const databasePath = path.join(root, "sdk-blocked-prompt.sqlite");
	const recorder = createFakeProviderRecorder();
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	let handle: SessionSdkHandle | undefined;
	let unsubscribe: (() => void) | undefined;
	try {
		const sessionId = await sdk.createEmptySession();
		projection.sqlite.exec(`
			CREATE TRIGGER reject_sdk_prompt_projection
			BEFORE UPDATE ON session
			BEGIN
				SELECT RAISE(ABORT, 'injected prompt projection failure');
			END;
		`);
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		const blocked = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		let blockedSnapshot: SessionSdkSnapshot | undefined;
		unsubscribe = handle.subscribe((snapshot) => {
			if (snapshot.storageError?.code === "session_projection_unavailable") {
				blockedSnapshot = snapshot;
				blocked.resolve();
				if (!snapshot.turnActive) {
					settled.resolve();
				}
			}
		});

		const admission = await handle.deliver({
			idempotencyKey: "blocked-prompt-delivery",
			text: "Persist before dispatch.",
		});
		expect(admission).toMatchObject({
			disposition: "started",
			rejected: false,
			writeOutcome: { kind: "committed", projection: "blocked" },
		});
		await Promise.race([
			Promise.all([blocked.promise, settled.promise]),
			Bun.sleep(5000).then(() => {
				throw new Error(
					"SDK did not settle the durable blocked-write outcome."
				);
			}),
		]);
		expect(blockedSnapshot?.storageError).toMatchObject({
			code: "session_projection_unavailable",
			writeOutcome: { kind: "committed", projection: "blocked" },
		});
		expect(blockedSnapshot?.turnActive).toBe(false);
		expect(JSON.stringify(blockedSnapshot?.transcript)).toContain(
			"Persist before dispatch."
		);
		expect(recorder.requests).toEqual([]);

		const logRoot = resolveLocalSessionLogRoot(databasePath);
		const entries = (
			await fs.readFile(
				path.join(logRoot, handle.sessionId, "session.jsonl"),
				"utf8"
			)
		)
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { operationId: string; type: string });
		const committedRecord = entries.find(
			({ type }) => type === "record.committed"
		);
		if (committedRecord === undefined) {
			throw new Error("The durable prompt record was not appended to JSONL.");
		}
		const receiptPath = path.join(
			path.dirname(logRoot),
			"session-control",
			"receipts",
			handle.sessionId,
			`${committedRecord.operationId}.json`
		);
		expect(await fs.readFile(receiptPath, "utf8")).toContain(
			committedRecord.operationId
		);
	} finally {
		unsubscribe?.();
		await handle?.dispose();
		projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_sdk_prompt_projection"
		);
		projection.sqlite.close();
		await sdk.dispose();
	}
});

test("metadata and selection replay from JSONL after the Session projection is lost", async () => {
	const databasePath = path.join(root, "sdk-replay-metadata.sqlite");
	const sdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let sessionId: SessionId;
	try {
		sessionId = await sdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			thinkingLevel: "high",
		});
	} finally {
		await sdk.dispose();
	}

	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
	});
	try {
		for (const input of [
			{ title: "Logged title" },
			{ pinned: true, title: "Temporary title" },
			{ pinned: true, title: "Logged title" },
		]) {
			expect(
				await services.store.updateSession(sessionId, input)
			).toMatchObject({ kind: "committed", projection: "ready" });
		}
		for (const mode of ["sloppy", "hashline", "sloppy"] as const) {
			expect(await services.store.setEditMode?.(sessionId, mode)).toMatchObject(
				{ kind: "committed", projection: "ready" }
			);
		}
	} finally {
		await services.shutdown();
	}

	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	projection.sqlite.query("DELETE FROM session WHERE id = ?").run(sessionId);
	projection.sqlite.close();

	const reopenedServices = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
	});
	try {
		const restored = await reopenedServices.store.getSession(sessionId);
		expect(restored).toMatchObject({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			pinned: true,
			thinkingLevel: "high",
			title: "Logged title",
		});
		await expect(reopenedServices.store.getEditMode?.(sessionId)).resolves.toBe(
			"sloppy"
		);
	} finally {
		await reopenedServices.shutdown();
	}
});

test("compaction checkpoints replay from JSONL and retries reuse their durable receipt", async () => {
	const databasePath = path.join(root, "sdk-replay-compaction.sqlite");
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
	});
	let sessionId: SessionId | undefined;
	try {
		const created = await services.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		expect(created.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		sessionId = created.id;
		const input = {
			estimatedTokensAfter: 64,
			firstKeptUiMessageId: sessionMessageId("jsonl-compaction-kept"),
			id: compactionId("jsonl-compaction-retry"),
			sessionId,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [sessionMessageId("jsonl-compaction-covered")],
				formatVersion: 1 as const,
				text: "Durably stored summary.",
			},
			throughMessageUiId: sessionMessageId("jsonl-compaction-through"),
			tokensBefore: 256,
			trigger: "threshold" as const,
		};
		const first = await services.store.appendCompaction(input);
		const retried = await services.store.appendCompaction(input);
		expect(first.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(first.compaction).toMatchObject({ id: input.id, sequence: 1 });
		expect(retried).toEqual(first);
	} finally {
		await services.shutdown();
	}

	if (sessionId === undefined) {
		throw new Error("The compaction test Session was not created.");
	}
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	projection.sqlite.query("DELETE FROM session WHERE id = ?").run(sessionId);
	projection.sqlite.close();
	const reopenedServices = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
	});
	try {
		expect(
			await reopenedServices.store.getLatestCompaction(sessionId)
		).toMatchObject({
			id: compactionId("jsonl-compaction-retry"),
			sequence: 1,
			summary: { text: "Durably stored summary." },
		});
		const log = await fs.readFile(
			path.join(root, "session-logs", sessionId, "session.jsonl"),
			"utf8"
		);
		expect(
			log
				.trimEnd()
				.split("\n")
				.map((line) => (JSON.parse(line) as { type: string }).type)
		).toEqual(["session.header", "session.created", "compaction.committed"]);
	} finally {
		await reopenedServices.shutdown();
	}
});

test("Session deletion persists a tombstone receipt before removing the projection", async () => {
	const databasePath = path.join(root, "sdk-delete-session.sqlite");
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
	});
	let sessionId: SessionId | undefined;
	try {
		const created = await services.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		expect(created.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		sessionId = created.id;
		const deleted = await services.store.deleteSession(sessionId);
		expect(deleted).toMatchObject({
			kind: "committed",
			projection: "ready",
			operationId: `delete-${sessionId}`,
		});
		if (deleted.kind !== "committed") {
			throw new Error("Session deletion was not durably committed.");
		}
		expect(
			(await services.store.listSessions()).some(({ id }) => id === sessionId)
		).toBe(false);
		const marker = JSON.parse(
			await fs.readFile(
				path.join(root, "session-control", "deleted", `${sessionId}.json`),
				"utf8"
			)
		) as Record<string, unknown>;
		expect(marker).toMatchObject({
			entryHash: deleted.entryHash,
			operationId: deleted.operationId,
			sequence: deleted.sequence,
			sessionId,
		});
		expect(await services.store.deleteSession(sessionId)).toEqual(deleted);
		await expect(
			fs.access(path.join(root, "session-logs", sessionId, "session.jsonl"))
		).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await services.shutdown();
	}
});

test("reopening rebuilds a missing SQLite projection from the committed Session log", async () => {
	const databasePath = path.join(root, "sdk-rebuild-projection.sqlite");
	const firstSdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let created: SessionSdkHandle | undefined;
	let sessionId: string | undefined;

	try {
		created = await firstSdk.createSession({
			initialPrompt: "Rebuild this accepted conversation from JSONL.",
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		sessionId = created.sessionId;
		await created.dispose();
		created = undefined;
	} finally {
		await created?.dispose();
		await firstSdk.dispose();
	}

	const projection = createDatabase(databasePath);
	projection.sqlite.query("DELETE FROM session WHERE id = ?").run(sessionId);
	projection.sqlite.close();

	const secondSdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let reopened: SessionSdkHandle | undefined;
	try {
		reopened = await secondSdk.openSession(sessionId, { autoContinue: false });
		let restoredText = false;
		const unsubscribe = reopened.subscribe(({ transcript }) => {
			restoredText = transcript.some(
				(message) =>
					JSON.stringify(message)?.includes(
						"Rebuild this accepted conversation from JSONL."
					) ?? false
			);
		});
		unsubscribe();
		expect(restoredText).toBe(true);
	} finally {
		await reopened?.dispose();
		await secondSdk.dispose();
	}
});

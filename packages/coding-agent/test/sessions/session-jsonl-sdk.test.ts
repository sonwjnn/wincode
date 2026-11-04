import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AgentTurnEvent,
	type AgentTurnId,
	SESSION_RECORD_VERSION,
	type SessionMessageId,
	type SessionRecord,
	type SessionRecordId,
	type SubmissionId,
	toSubmissionId,
} from "@wincode/agent-core";
import { createSessionSdk } from "@wincode/coding-agent";
import { readUtf8File } from "@wincode/utils";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { attachmentReferenceToFilePart } from "@/modules/sessions/attachment-reference";
import { rebuildActiveMessages } from "@/modules/sessions/compaction/compaction";
import type { AppendSessionCompactionInput } from "@/modules/sessions/compaction/types";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type { SessionHost } from "@/modules/sessions/host/types";
import { createSessionUserMessage } from "@/modules/sessions/message";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import type {
	SessionSdkHandle,
	SessionSdkSnapshot,
	SessionSdkSubmissionAdmission,
} from "@/modules/sessions/sdk-contract";
import {
	type AttachmentMaintenanceReport,
	type AttachmentMetadataRepository,
	createDrizzleAttachmentMetadataRepository,
	createMemoryAttachmentMetadataRepository,
	createSessionAttachmentStore,
	getAttachmentReference,
	type SessionAttachmentStore,
} from "@/modules/sessions/storage/attachment-store";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
} from "@/modules/sessions/storage/path";
import { validateSessionBundleDirectory } from "@/modules/sessions/storage/session-bundle";
import {
	createSessionLogEvent,
	decodeSessionLog,
	encodeCanonicalSessionJson,
	encodeSessionLogLine,
	sessionLogOperationDigest,
} from "@/modules/sessions/storage/session-jsonl-codec";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import {
	decodeSessionPageToken,
	encodeSessionPageToken,
} from "@/modules/sessions/storage/session-pagination";
import { buildUserSessionRecord } from "@/modules/sessions/storage/session-record";
import { SESSION_DIRECTORY_STAGING_PREFIX } from "@/modules/sessions/storage/session-storage-durability";
import type {
	PromptHistoryEntry,
	SessionStore,
} from "@/modules/sessions/storage/session-store";
import {
	type SessionWriterLock,
	withSessionCatalogLifecycleGate,
} from "@/modules/sessions/storage/session-writer-lock";
import { projectSessionRecords } from "@/modules/sessions/transcript-projection";
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
	sessionRecordId,
	sessionUsageEntryId,
	toolCallId,
} from "../support/identifiers";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-session-jsonl-"));
const workspace = path.join(root, "workspace");
const workspaceToolFixtures: string[] = [];
const operationIdFileStem = (operationId: string): string =>
	new Bun.CryptoHasher("sha256").update(operationId).digest("hex");
const ATTACHMENT_ID_PATTERN = /"attachmentId":"(v1-[0-9a-f]{64})"/u;
const PNG_BYTES = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
await fs.mkdir(workspace, { recursive: true });

const isTerminalAgentTurnEvent = (event: AgentTurnEvent): boolean =>
	event.type === "agent-turn-completed" ||
	event.type === "agent-turn-failed" ||
	event.type === "agent-turn-cancelled" ||
	event.type === "agent-turn-interrupted";

afterAll(async () => {
	await removeTemporaryDirectory(root);
	await Promise.all(workspaceToolFixtures.map(removeTemporaryDirectory));
});

const readSessionLogLines = async <Payload>(
	logRoot: string,
	sessionId: SessionId
): Promise<readonly Readonly<{ payload?: Payload; type: string }>[]> =>
	(await Bun.file(path.join(logRoot, sessionId, "session.jsonl")).text())
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as { payload?: Payload; type: string });

const createSessionJsonlTestPersistence = (
	databasePath: string,
	workspaceRoot: string,
	fileIo: SessionLogFileIo = {},
	syncBlob?: (handle: fs.FileHandle) => Promise<void>,
	attachmentRepositoryOverride?: AttachmentMetadataRepository
) => {
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const attachmentRoot = path.join(path.dirname(databasePath), "attachments");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const attachmentRepository =
		attachmentRepositoryOverride ??
		createDrizzleAttachmentMetadataRepository(projection.db);
	const attachmentStore = createSessionAttachmentStore({
		lifecycleRoot: logRoot,
		repository: attachmentRepository,
		root: attachmentRoot,
		...(syncBlob === undefined ? {} : { syncBlob }),
	});
	const projectionStore = createDrizzleSessionStore(projection.db, {
		attachmentRoot,
		attachmentStore,
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot, fileIo);
	return {
		attachmentRepository,
		attachmentStore,
		close: () => {
			operational.sqlite.close();
			projection.sqlite.close();
		},
		operational,
		projection,
		store,
	};
};

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
		const text = await readUtf8File(logPath);
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

test("public Session SDK exports an idle Session through the authoritative bundle operation", async () => {
	const databasePath = path.join(root, "sdk-session-export.sqlite");
	const sdk = await createSessionSdk({
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	const destination = path.join(root, "sdk-session-export");
	try {
		const sessionId = await sdk.createEmptySession();
		const result = await sdk.exportSessionBundle(sessionId, destination);
		const validated = await validateSessionBundleDirectory(destination);

		expect(result).toMatchObject({
			destination,
			sessionId,
			status: "exported",
		});
		expect(result.manifest.source).toEqual({ workspacePath: workspace });
		expect(validated.session).toEqual({
			id: sessionId,
			logId: result.manifest.session.logId,
		});
	} finally {
		await sdk.dispose();
	}
});

test("an SDK Session handle forks its committed terminal checkpoint into a new idle Session", async () => {
	const databasePath = path.join(root, "sdk-handle-fork.sqlite");
	const recorder = createFakeProviderRecorder();
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let handle: SessionSdkHandle | undefined;
	let forkHandle: SessionSdkHandle | undefined;
	try {
		const sourceSessionId = await sdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		handle = await sdk.openSession(sourceSessionId, { autoContinue: false });
		const turnTerminal = Promise.withResolvers<void>();
		const unsubscribe = handle.onEvent((event) => {
			if (isTerminalAgentTurnEvent(event)) {
				turnTerminal.resolve();
			}
		});
		const admission = await handle.deliver({
			idempotencyKey: "sdk-handle-fork-delivery",
			text: "Finish the source Agent Turn before creating a fork.",
		});
		await turnTerminal.promise;
		unsubscribe();
		expect(admission).toMatchObject({
			disposition: "started",
			rejected: false,
		});
		const sourceHistory = await sdk.readSessionHistoryPage(sourceSessionId);
		const checkpoint = sourceHistory.records.at(-1);
		if (checkpoint === undefined) {
			throw new Error("The completed source Agent Turn has no checkpoint.");
		}

		const fork = await handle.fork(
			{ recordId: checkpoint.id },
			"sdk-handle-fork-operation"
		);
		const sdkFork = await sdk.forkSession(
			sourceSessionId,
			{ recordId: checkpoint.id },
			"sdk-root-fork-operation"
		);
		const forkHistory = await sdk.readSessionHistoryPage(fork.id);
		const forkStatistics = await sdk.getSessionStatistics(fork.id);

		expect(fork.created).toBe(true);
		expect(sdkFork.created).toBe(true);
		expect(fork.handle.sessionId).toBe(fork.id);
		expect(sdkFork.handle.sessionId).toBe(sdkFork.id);
		let rootForkSnapshot: SessionSdkSnapshot | undefined;
		const unsubscribeRootForkSnapshot = sdkFork.handle.subscribe((snapshot) => {
			rootForkSnapshot = snapshot;
		});
		expect(rootForkSnapshot?.turnActive).toBe(false);
		unsubscribeRootForkSnapshot();
		expect(sdkFork.id).not.toBe(fork.id);
		expect(fork.id).not.toBe(sourceSessionId);
		expect(forkHistory.records.at(-1)?.messages.at(-1)?.role).toBe("assistant");
		expect(forkStatistics.usage.actual.contributionCount).toBe(0);
		expect(forkStatistics.usage.inherited.contributionCount).toBeGreaterThan(0);
		expect(
			await handle.deliver({
				idempotencyKey: "sdk-handle-fork-source-continues",
				text: "The source Host remains usable after forking.",
			})
		).toMatchObject({
			disposition: "started",
			rejected: false,
		});
		forkHandle = fork.handle;
		let forkSnapshot: SessionSdkSnapshot | undefined;
		forkHandle.subscribe((snapshot) => {
			forkSnapshot = snapshot;
		});
		expect(forkSnapshot?.turnActive).toBe(false);
		const forkTurnTerminal = Promise.withResolvers<void>();
		const unsubscribeForkEvents = forkHandle.onEvent((event) => {
			if (isTerminalAgentTurnEvent(event)) {
				forkTurnTerminal.resolve();
			}
		});
		expect(await forkHandle.continue()).toMatchObject({ kind: "resumed" });
		await forkTurnTerminal.promise;
		unsubscribeForkEvents();
		const rootForkTurnTerminal = Promise.withResolvers<void>();
		const unsubscribeRootForkEvents = sdkFork.handle.onEvent((event) => {
			if (isTerminalAgentTurnEvent(event)) {
				rootForkTurnTerminal.resolve();
			}
		});
		expect(await sdkFork.handle.continue()).toMatchObject({ kind: "resumed" });
		await rootForkTurnTerminal.promise;
		unsubscribeRootForkEvents();
		expect(recorder.requests).toHaveLength(4);
		expect(recorder.requests.at(-1)).toMatchObject({
			kind: "chat",
			messages: [
				{
					role: "user",
					text: "Finish the source Agent Turn before creating a fork.",
				},
				{ role: "assistant", text: "E2E chat response" },
			],
		});
	} finally {
		await forkHandle?.dispose();
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("Session services fork operation returns a usable SDK handle", async () => {
	const databasePath = path.join(root, "session-services-fork.sqlite");
	const recorder = createFakeProviderRecorder();
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => persistence.store,
		},
	});
	let sourceHandle: SessionSdkHandle | undefined;
	let forkHandle: SessionSdkHandle | undefined;
	let unsubscribeSourceEvents: (() => void) | undefined;
	let unsubscribeForkEvents: (() => void) | undefined;
	try {
		const sourceSessionId = await services.sessionSdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		sourceHandle = await services.sessionSdk.openSession(sourceSessionId, {
			autoContinue: false,
		});
		const sourceTurnTerminal = Promise.withResolvers<void>();
		unsubscribeSourceEvents = sourceHandle.onEvent((event) => {
			if (isTerminalAgentTurnEvent(event)) {
				sourceTurnTerminal.resolve();
			}
		});
		await sourceHandle.deliver({
			idempotencyKey: "session-services-fork-source",
			text: "Complete the source turn before the service forks it.",
		});
		await sourceTurnTerminal.promise;
		unsubscribeSourceEvents();
		const history =
			await services.sessionSdk.readSessionHistoryPage(sourceSessionId);
		const checkpoint = history.records.at(-1);
		if (checkpoint === undefined) {
			throw new Error("The source Session has no completed checkpoint.");
		}

		const fork = await services.sessionSdk.forkSession(
			sourceSessionId,
			{ recordId: checkpoint.id },
			"session-services-fork-operation"
		);
		forkHandle = fork.handle;
		expect(fork.handle.sessionId).toBe(fork.id);
		const forkTurnTerminal = Promise.withResolvers<void>();
		unsubscribeForkEvents = forkHandle.onEvent((event) => {
			if (isTerminalAgentTurnEvent(event)) {
				forkTurnTerminal.resolve();
			}
		});
		expect(await forkHandle.continue()).toMatchObject({ kind: "resumed" });
		await forkTurnTerminal.promise;
	} finally {
		unsubscribeSourceEvents?.();
		unsubscribeForkEvents?.();
		await forkHandle?.dispose();
		await sourceHandle?.dispose();
		await services.shutdown();
		persistence.close();
	}
});

test("SDK delivery retries preserve one durable receipt across projection rebuild and restart", async () => {
	const databasePath = path.join(
		root,
		"sdk-delivery-restart",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const firstRecorder = createFakeProviderRecorder();
	const firstSdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(firstRecorder),
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let sessionId: SessionId;
	let firstHandle: SessionSdkHandle | undefined;
	let firstAdmission: SessionSdkSubmissionAdmission;
	try {
		sessionId = await firstSdk.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		firstHandle = await firstSdk.openSession(sessionId, {
			autoContinue: false,
		});
		const firstDelivery = firstHandle.deliver({
			idempotencyKey: "delivery-restart-key",
			text: "Persist this SDK delivery once.",
		});
		const inFlightConflict = await firstHandle.deliver({
			idempotencyKey: "delivery-restart-key",
			text: "A different payload cannot reuse this key.",
		});
		expect(inFlightConflict).toMatchObject({
			code: "session_operation_conflict",
			rejected: true,
		});
		firstAdmission = await firstDelivery;
		expect(firstAdmission).toMatchObject({
			disposition: "started",
			rejected: false,
			writeOutcome: { kind: "committed", projection: "ready" },
		});
	} finally {
		await firstHandle?.dispose();
		await firstSdk.dispose();
	}
	if (firstAdmission.rejected) {
		throw new Error("The first SDK delivery was not accepted.");
	}

	const rebuildPersistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	try {
		const rebuilt = await rebuildPersistence.store.rebuildProjection(
			{ kind: "all" },
			async (operation) => await operation()
		);
		expect(rebuilt.issues).toEqual([]);
	} finally {
		rebuildPersistence.close();
	}

	const secondRecorder = createFakeProviderRecorder();
	const secondSdk = await createSessionSdkWithRuntime({
		createProviderCollection: () =>
			createFakeProviderCollection(secondRecorder),
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	let reopened: SessionSdkHandle | undefined;
	try {
		reopened = await secondSdk.openSession(sessionId, { autoContinue: false });
		const unrelatedIntentPath = path.join(
			path.dirname(resolveLocalSessionLogRoot(databasePath)),
			"session-control",
			"indeterminate",
			`${sessionId}.json`
		);
		await fs.mkdir(path.dirname(unrelatedIntentPath), { recursive: true });
		await Bun.write(
			unrelatedIntentPath,
			JSON.stringify({
				expectedOffset: 1,
				operationDigest: "a".repeat(64),
				operationId: "unrelated-pending-write",
				sequence: 2,
				sessionId,
				timestamp: "2026-10-31T12:00:00.000Z",
				type: "record.committed",
				version: 2,
			})
		);
		const duplicate = await reopened.deliver({
			idempotencyKey: "delivery-restart-key",
			text: "Persist this SDK delivery once.",
		});
		expect(duplicate).toMatchObject({
			disposition: "duplicate",
			messageId: firstAdmission.messageId,
			rejected: false,
			submissionId: firstAdmission.submissionId,
			writeOutcome: firstAdmission.writeOutcome,
		});
		projection.sqlite.exec("DROP TABLE session_projection_cursor");
		const blockedDuplicate = await reopened.deliver({
			idempotencyKey: "delivery-restart-key",
			text: "Persist this SDK delivery once.",
		});
		expect(blockedDuplicate).toMatchObject({
			disposition: "duplicate",
			messageId: firstAdmission.messageId,
			rejected: false,
			submissionId: firstAdmission.submissionId,
			writeOutcome: { kind: "committed", projection: "blocked" },
		});
		const conflict = await reopened.deliver({
			idempotencyKey: "delivery-restart-key",
			text: "A different payload cannot reuse this key.",
		});
		expect(conflict).toMatchObject({
			code: "session_operation_conflict",
			rejected: true,
		});
		expect(secondRecorder.requests).toEqual([]);

		const entries = await readSessionLogLines<{
			record?: {
				messages?: Array<{ metadata?: { submissionId?: string } }>;
			};
		}>(resolveLocalSessionLogRoot(databasePath), sessionId);
		expect(
			entries.filter(
				(entry) =>
					entry.type === "record.committed" &&
					entry.payload?.record?.messages?.[0]?.metadata?.submissionId ===
						firstAdmission.submissionId
			).length
		).toBe(1);
	} finally {
		await reopened?.dispose();
		await secondSdk.dispose();
		projection.sqlite.close();
	}
});

test("SDK delivery replays a synced Session record after the process exits before acknowledgement", async () => {
	const databasePath = path.join(root, "sdk-delivery-crash-before-ack.sqlite");
	const workerPath = path.join(
		import.meta.dir,
		"../support/session-jsonl-crash-delivery-worker.ts"
	);
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "run", workerPath],
		{
			cwd: process.cwd(),
			env: {
				HOME: root,
				NODE_ENV: "test",
				PATH: process.env.PATH ?? "",
				TEST_DATABASE_PATH: databasePath,
				TEST_WORKSPACE: workspace,
				WINCODE_TEST_SESSION_INDEX_DIR:
					process.env.WINCODE_TEST_SESSION_INDEX_DIR ??
					path.join(root, "session-index"),
				XDG_DATA_HOME: path.join(root, "data"),
			},
			stderr: "pipe",
			stdout: "pipe",
		}
	);
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	const childStderr = new Response(child.stderr).text();
	let buffered = "";
	const readLine = async (): Promise<string> => {
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				return line;
			}
			const next = await reader.read();
			if (next.done) {
				throw new Error("Crash-test worker exited before reporting its sync.");
			}
			buffered += decoder.decode(next.value, { stream: true });
		}
	};
	let sessionId: SessionId | undefined;
	try {
		const sessionEvent = JSON.parse(await readLine()) as {
			kind: string;
			sessionId?: string;
		};
		if (
			sessionEvent.kind !== "session" ||
			sessionEvent.sessionId === undefined
		) {
			throw new Error("Crash-test worker did not report its Session ID.");
		}
		sessionId = toSessionId(sessionEvent.sessionId);
		const syncEvent = JSON.parse(await readLine()) as { kind: string };
		if (syncEvent.kind !== "log-synced") {
			throw new Error(
				`Expected the JSONL sync boundary, received ${syncEvent.kind}.`
			);
		}
		child.kill("SIGKILL");
		await child.exited;
	} finally {
		try {
			child.kill("SIGKILL");
		} catch {
			// The worker may already have exited.
		}
		await child.exited;
		reader.releaseLock();
		await childStderr;
	}
	if (sessionId === undefined) {
		throw new Error("The crash-test worker did not create a Session.");
	}

	const recorder = createFakeProviderRecorder();
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(recorder),
		cwd: workspace,
		databasePath,
		pluginPaths: [],
		workspace,
	});
	let reopened: SessionSdkHandle | undefined;
	try {
		reopened = await sdk.openSession(sessionId, { autoContinue: false });
		const duplicate = await reopened.deliver({
			idempotencyKey: "crash-before-ack",
			text: "Persist this before the process exits.",
		});
		expect(duplicate).toMatchObject({
			disposition: "duplicate",
			rejected: false,
			writeOutcome: { kind: "committed" },
		});
		if (duplicate.rejected) {
			throw new Error("The replayed SDK delivery was not accepted.");
		}
		expect(recorder.requests).toEqual([]);
		const entries = (
			await readSessionLogLines<{
				record?: {
					messages?: Array<{ metadata?: { submissionId?: string } }>;
				};
			}>(resolveLocalSessionLogRoot(databasePath), sessionId)
		).filter(
			(entry) =>
				entry.type === "record.committed" &&
				entry.payload?.record?.messages?.[0]?.metadata?.submissionId ===
					duplicate.submissionId
		);
		expect(entries).toHaveLength(1);
	} finally {
		await reopened?.dispose();
		await sdk.dispose();
	}
});

test("processing steering status reopens as a failed durable head with stable identities", async () => {
	const databasePath = path.join(
		root,
		"sdk-steering-status-restart",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const recorder = createFakeProviderRecorder();
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => persistence.store,
		},
	});
	let sessionId: SessionId;
	let messageId: SessionMessageId;
	let recordId: SessionRecordId;
	let submissionId: SubmissionId;
	try {
		const created = await persistence.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The test Session was not durably created.");
		}
		sessionId = created.id;
		messageId = sessionMessageId("sdk-steering-restart-message");
		submissionId = toSubmissionId("sdk-steering-restart-submission");
		const record = buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: messageId,
				metadata: {
					agent: agentId("build"),
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					submissionId,
					submissionStatus: "pending",
				},
				parts: [{ text: "resume status from JSONL", type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("sdk-steering-restart-turn"),
		});
		recordId = record.id;
		expect(
			await persistence.store.commitSessionRecord({
				record,
				sessionId: created.id,
			})
		).toMatchObject({ kind: "committed", projection: "ready" });
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_steering_status_projection
			BEFORE UPDATE ON session_record
			BEGIN
				SELECT RAISE(ABORT, 'injected steering status projection failure');
			END;
		`);
		const status = await persistence.store.updateSessionSubmission({
			messageId,
			recordId,
			sessionId: created.id,
			status: "processing",
			submissionId,
		});
		expect(status).toMatchObject({ kind: "committed", projection: "blocked" });
	} finally {
		persistence.projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_steering_status_projection"
		);
		await services.shutdown();
		persistence.close();
	}

	const reopenedPersistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const rebuilt = await reopenedPersistence.store.rebuildProjection(
		{ kind: "all" },
		async (operation) => await operation()
	);
	expect(rebuilt.issues).toEqual([]);
	const reopenedServices = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => reopenedPersistence.store,
		},
	});
	let host: SessionHost | undefined;
	try {
		host = await reopenedServices.capabilities
			.getSessionHostManager()
			.openHost({
				autoContinue: false,
				capabilities: reopenedServices.capabilities,
				sessionId,
				view: true,
			});
		expect(host.getSnapshot().steeringMessages).toMatchObject([
			{
				id: `steering-${messageId}`,
				message: { id: messageId },
				recordId,
				input: { submissionId },
				status: "failed",
				reason:
					"Session closed before provider processing could be confirmed; deliberate retry required.",
			},
		]);
		expect(recorder.requests).toEqual([]);
		const statusEvents = (
			await Bun.file(
				path.join(
					resolveLocalSessionLogRoot(databasePath),
					sessionId,
					"session.jsonl"
				)
			).text()
		)
			.trimEnd()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						payload?: {
							messageId?: string;
							recordId?: string;
							status?: string;
							submissionId?: string;
						};
						type: string;
					}
			)
			.filter(({ type }) => type === "submission.status-updated");
		expect(statusEvents).toMatchObject([
			{
				payload: {
					messageId,
					recordId,
					status: "processing",
					submissionId,
				},
			},
			{
				payload: {
					messageId,
					recordId,
					status: "failed",
					submissionId,
				},
			},
		]);
	} finally {
		await host?.shutdown();
		await reopenedServices.shutdown();
		reopenedPersistence.close();
	}
});

test("a rebuilt failed Steering Message retries to one provider request without a duplicate user record", async () => {
	const databasePath = path.join(
		root,
		"sdk-steering-retry-rebuild",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const recorder = createFakeProviderRecorder();
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	let sessionId: SessionId;
	let messageId: SessionMessageId;
	try {
		const created = await persistence.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The test Session was not durably created.");
		}
		sessionId = created.id;
		messageId = sessionMessageId("sdk-steering-retry-message");
		const submissionId = toSubmissionId("sdk-steering-retry-submission");
		const record = buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: messageId,
				metadata: {
					agent: agentId("build"),
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					submissionId,
					submissionStatus: "pending",
				},
				parts: [{ text: "retry steering after rebuild", type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("sdk-steering-retry-turn"),
		});
		expect(
			await persistence.store.commitSessionRecord({
				record,
				sessionId: created.id,
			})
		).toMatchObject({ kind: "committed" });
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_steering_retry_projection
			BEFORE UPDATE ON session_record
			BEGIN
				SELECT RAISE(ABORT, 'injected steering retry projection failure');
			END;
		`);
		expect(
			await persistence.store.updateSessionSubmission({
				messageId,
				recordId: record.id,
				sessionId: created.id,
				status: "processing",
				submissionId,
			})
		).toMatchObject({ kind: "committed", projection: "blocked" });
	} finally {
		persistence.projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_steering_retry_projection"
		);
		persistence.close();
	}

	const rebuiltPersistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	try {
		const rebuilt = await rebuiltPersistence.store.rebuildProjection(
			{ kind: "all" },
			async (operation) => await operation()
		);
		expect(rebuilt.issues).toEqual([]);
		const services = await openSessionServices({
			policy: { cwd: workspace, databasePath, workspace },
			sources: {
				createProviderCollection: () => createFakeProviderCollection(recorder),
				store: () => rebuiltPersistence.store,
			},
		});
		let host: SessionHost | undefined;
		try {
			host = await services.capabilities.getSessionHostManager().openHost({
				autoContinue: false,
				capabilities: services.capabilities,
				sessionId,
				view: true,
			});
			expect(host.getSnapshot().steeringMessages).toMatchObject([
				{ message: { id: messageId }, status: "failed" },
			]);
			const retried = await host.agentSession.send({
				agent: agentId("build"),
				composition: { files: [], text: "retry steering after rebuild" },
				messageId,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				userText: "retry steering after rebuild",
			});
			expect(retried).toEqual({ rejected: false });
			expect(recorder.requests).toMatchObject([
				{
					kind: "chat",
					messages: expect.arrayContaining([
						{ role: "user", text: "retry steering after rebuild" },
					]),
				},
			]);
			expect(host.getSnapshot().steeringMessages).toEqual([]);
			const durableEntries = (
				await readSessionLogLines<{
					record?: { messages?: Array<{ id?: string }> };
				}>(resolveLocalSessionLogRoot(databasePath), sessionId)
			).filter(
				(entry) =>
					entry.type === "record.committed" &&
					entry.payload?.record?.messages?.some(
						(message) => message.id === messageId
					) === true
			);
			expect(durableEntries).toHaveLength(1);
			expect(
				await rebuiltPersistence.store.listSessionUsageEntries(sessionId)
			).toEqual([]);
		} finally {
			await host?.shutdown();
			await services.shutdown();
		}
	} finally {
		rebuiltPersistence.close();
	}
});

test("another process cannot collect queued attachment blobs until each owning Submission releases them", async () => {
	const testRoot = path.join(root, "cross-process-retained-attachments");
	const testWorkspace = path.join(testRoot, "workspace");
	await fs.mkdir(testWorkspace, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const recorder = createFakeProviderRecorder();
	const modelStarted = Promise.withResolvers<void>();
	const releaseModel = Promise.withResolvers<void>();
	recorder.beforeChat = async () => {
		modelStarted.resolve();
		await releaseModel.promise;
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	const services = await openSessionServices({
		policy: {
			cwd: testWorkspace,
			databasePath,
			workspace: testWorkspace,
		},
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => persistence.store,
		},
	});
	const childSource = `
import { createDrizzleAttachmentMetadataRepository, createSessionAttachmentStore } from "./packages/coding-agent/modules/sessions/storage/attachment-store.ts";
import { createDatabase } from "./packages/coding-agent/modules/sessions/storage/client.ts";
const projection = createDatabase(process.env.TEST_PROJECTION_PATH);
const attachments = createSessionAttachmentStore({
  lifecycleRoot: process.env.TEST_LOG_ROOT,
  repository: createDrizzleAttachmentMetadataRepository(projection.db),
  root: process.env.TEST_ATTACHMENT_ROOT,
});
try {
  const result = await attachments.collect({ liveAttachmentIds: [], safetyWindowMs: 0 });
  process.stdout.write(JSON.stringify(result));
} finally {
  projection.sqlite.close();
}
`;
	const collectInAnotherProcess =
		async (): Promise<AttachmentMaintenanceReport> => {
			const child = Bun.spawn(
				[process.execPath, "--no-env-file", "-e", childSource],
				{
					cwd: process.cwd(),
					env: {
						HOME: testRoot,
						NODE_ENV: "test",
						PATH: process.env.PATH ?? "",
						XDG_DATA_HOME: path.join(testRoot, "data"),
						TEST_ATTACHMENT_ROOT: path.join(testRoot, "attachments"),
						TEST_LOG_ROOT: resolveLocalSessionLogRoot(databasePath),
						TEST_PROJECTION_PATH:
							resolveLocalSessionProjectionPath(databasePath),
						WINCODE_TEST_SESSION_INDEX_DIR:
							process.env.WINCODE_TEST_SESSION_INDEX_DIR ??
							path.join(testRoot, "session-index"),
					},
					stderr: "pipe",
					stdout: "pipe",
				}
			);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (exitCode !== 0) {
				throw new Error(`Attachment collector process failed: ${stderr}`);
			}
			return JSON.parse(stdout) as AttachmentMaintenanceReport;
		};
	let host: SessionHost | undefined;
	let activeTurn: Promise<unknown> | undefined;
	try {
		const created = await services.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		host = await services.capabilities.getSessionHostManager().openHost({
			capabilities: services.capabilities,
			autoContinue: false,
			sessionId: created.id,
		});
		activeTurn = host.agentSession.send({
			agent: agentId("build"),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			userText: "Hold the Session Writer while queued files wait.",
		});
		await modelStarted.promise;
		const attachmentLease = await persistence.attachmentStore.ingest({
			bytes: PNG_BYTES,
			filename: "queued.png",
			mediaType: "image/png",
		});
		const attachment = attachmentLease.reference;
		const attachmentRecord = persistence.attachmentRepository.get(
			attachment.attachmentId
		);
		if (attachmentRecord === undefined) {
			throw new Error("Queued attachment metadata was not persisted.");
		}
		await attachmentLease.release();
		const queuedInput = {
			agent: agentId("build"),
			files: [attachmentReferenceToFilePart(attachment)],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			userText: "Keep this referenced image queued.",
		};
		const first = await host.agentSession.prompt(queuedInput);
		const second = await host.agentSession.prompt(queuedInput);
		expect(first).toMatchObject({ disposition: "queued", rejected: false });
		expect(second).toMatchObject({ disposition: "queued", rejected: false });
		if (!("submissionId" in first && "submissionId" in second)) {
			throw new Error("The retained attachment Submissions were not queued.");
		}

		const firstCollection = await collectInAnotherProcess();
		expect(firstCollection.reclaimedCount).toBe(0);
		expect(
			await Bun.file(
				path.join(testRoot, "attachments", attachmentRecord.blobKey)
			).exists()
		).toBe(true);

		await expect(
			host.agentSession.recallWaitingMessages([first.submissionId])
		).resolves.toHaveLength(1);
		const oneOwnerRemains = await collectInAnotherProcess();
		expect(oneOwnerRemains.reclaimedCount).toBe(0);
		expect(
			await Bun.file(
				path.join(testRoot, "attachments", attachmentRecord.blobKey)
			).exists()
		).toBe(true);

		await expect(
			host.agentSession.recallWaitingMessages([second.submissionId])
		).resolves.toHaveLength(1);
		const allOwnersReleased = await collectInAnotherProcess();
		expect(allOwnersReleased.reclaimedCount).toBe(1);
		expect(
			await Bun.file(
				path.join(testRoot, "attachments", attachmentRecord.blobKey)
			).exists()
		).toBe(false);
	} finally {
		releaseModel.resolve();
		await activeTurn?.catch(() => undefined);
		await host?.shutdown();
		await services.shutdown();
		persistence.close();
	}
});

test("Session publication cannot race GC before its referenced attachment is discoverable", async () => {
	const testRoot = path.join(root, "session-publication-gc-boundary");
	const testWorkspace = path.join(testRoot, "workspace");
	await fs.mkdir(testWorkspace, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const stagedReference = Promise.withResolvers<void>();
	const allowStagedReferenceWrite = Promise.withResolvers<void>();
	let attachmentId: string | undefined;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			const text = new TextDecoder().decode(
				bytes.subarray(offset, offset + length)
			);
			if (
				filePath.includes(`${path.sep}.staging${path.sep}`) &&
				attachmentId !== undefined &&
				text.includes(attachmentId)
			) {
				stagedReference.resolve();
				await allowStagedReferenceWrite.promise;
			}
			const result = await handle.write(bytes, offset, length, position);
			return result.bytesWritten;
		},
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace,
		fileIo
	);
	const referenceLease = await persistence.attachmentStore.ingest({
		bytes: PNG_BYTES,
		filename: "published.png",
		mediaType: "image/png",
	});
	const reference = referenceLease.reference;
	await referenceLease.release();
	attachmentId = reference.attachmentId;
	let createOperation: Promise<unknown> | undefined;
	let collectionOperation: Promise<AttachmentMaintenanceReport> | undefined;
	try {
		const sessionId = toSessionId("publish-gc-boundary-session");
		const message = {
			id: sessionMessageId("publish-gc-boundary-message"),
			parts: [attachmentReferenceToFilePart(reference)],
			role: "user" as const,
		};
		const creating = persistence.store.createSession({
			agent: agentId("build"),
			id: sessionId,
			message,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("publish-gc-boundary-turn"),
		});
		createOperation = creating;
		await stagedReference.promise;
		// The append is paused after leasing the existing reference. GC must be
		// able to acquire the catalog gate during this ordinary JSONL write and
		// preserve the blob using the lease pin.
		collectionOperation = persistence.attachmentStore.collect({
			liveAttachmentIds: [],
			safetyWindowMs: 0,
		});
		await expect(collectionOperation).resolves.toMatchObject({
			reclaimedCount: 0,
		});
		expect(
			await Bun.file(path.join(logRoot, sessionId, "session.jsonl")).exists()
		).toBe(false);
		allowStagedReferenceWrite.resolve();
		const created = await creating;
		expect(created).toMatchObject({
			writeOutcome: { kind: "committed", projection: "ready" },
		});
		expect(
			await Bun.file(
				path.join(
					testRoot,
					"attachments",
					"v1",
					reference.attachmentId.slice(3, 5),
					reference.attachmentId.slice(5, 7),
					`${reference.attachmentId}.blob`
				)
			).exists()
		).toBe(true);
	} finally {
		allowStagedReferenceWrite.resolve();
		await createOperation?.catch(() => undefined);
		await collectionOperation?.catch(() => undefined);
		persistence.close();
	}
});

test("Session creation rejects an existing attachment reclaimed before its lease is created", async () => {
	const testRoot = path.join(root, "preexisting-attachment-gc-boundary");
	const testWorkspace = path.join(testRoot, "workspace");
	await fs.mkdir(testWorkspace, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const collectorCheckedReservation = Promise.withResolvers<void>();
	const backingRepository = createMemoryAttachmentMetadataRepository();
	let observeCollectorReservationCheck = false;
	const attachmentRepository: AttachmentMetadataRepository = {
		delete: (attachmentId) => backingRepository.delete(attachmentId),
		get: (attachmentId) => {
			const record = backingRepository.get(attachmentId);
			if (observeCollectorReservationCheck) {
				observeCollectorReservationCheck = false;
				collectorCheckedReservation.resolve();
			}
			return record;
		},
		list: () => backingRepository.list(),
		put: (record) => backingRepository.put(record),
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace,
		{},
		undefined,
		attachmentRepository
	);
	const sourceLease = await persistence.attachmentStore.ingest({
		bytes: PNG_BYTES,
		filename: "pre-existing.png",
		mediaType: "image/png",
	});
	const reference = sourceLease.reference;
	await sourceLease.release();
	const message = {
		id: sessionMessageId("preexisting-gc-boundary-message"),
		parts: [attachmentReferenceToFilePart(reference)],
		role: "user" as const,
	};
	const sessionId = toSessionId("preexisting-gc-boundary-session");
	let collectionOperation: Promise<AttachmentMaintenanceReport> | undefined;
	let creationOperation: Promise<unknown> | undefined;
	try {
		// This repository seam fires during GC's reservation check, after it has
		// snapshotted pins. The subsequent Session creation races that in-flight
		// collection instead of pre-staging a pin before GC starts.
		observeCollectorReservationCheck = true;
		collectionOperation = persistence.attachmentStore.collect({
			liveAttachmentIds: [],
			safetyWindowMs: 0,
		});
		await collectorCheckedReservation.promise;
		creationOperation = persistence.store.createSession({
			agent: agentId("build"),
			id: sessionId,
			message,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("preexisting-gc-boundary-turn"),
		});
		await expect(collectionOperation).resolves.toMatchObject({
			reclaimedCount: 1,
		});
		const created = await creationOperation;
		expect(created).toMatchObject({
			writeOutcome: {
				kind: "not-committed",
				error: {
					message: expect.stringContaining(
						"Referenced attachment blob is unavailable"
					),
				},
			},
		});
		expect(
			await Bun.file(path.join(logRoot, sessionId, "session.jsonl")).exists()
		).toBe(false);
		expect(
			await Bun.file(
				path.join(
					testRoot,
					"attachments",
					"v1",
					reference.attachmentId.slice(3, 5),
					reference.attachmentId.slice(5, 7),
					`${reference.attachmentId}.blob`
				)
			).exists()
		).toBe(false);
	} finally {
		await collectionOperation?.catch(() => undefined);
		await creationOperation?.catch(() => undefined);
		persistence.close();
	}
});

test("Session deletion cannot race GC while its published log is being removed", async () => {
	const testRoot = path.join(root, "session-deletion-gc-boundary");
	const testWorkspace = path.join(testRoot, "workspace");
	await fs.mkdir(testWorkspace, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const deletedRecordWritten = Promise.withResolvers<void>();
	let watchDeletion = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			const result = await handle.write(bytes, offset, length, position);
			if (watchDeletion && filePath.endsWith("session.jsonl")) {
				const text = new TextDecoder().decode(
					bytes.subarray(offset, offset + length)
				);
				if (text.includes('"type":"session.deleted"')) {
					deletedRecordWritten.resolve();
				}
			}
			return result.bytesWritten;
		},
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace,
		fileIo
	);
	const referenceLease = await persistence.attachmentStore.ingest({
		bytes: PNG_BYTES,
		filename: "deleted.png",
		mediaType: "image/png",
	});
	const reference = referenceLease.reference;
	await referenceLease.release();
	const sessionId = toSessionId("delete-gc-boundary-session");
	const message = {
		id: sessionMessageId("delete-gc-boundary-message"),
		parts: [attachmentReferenceToFilePart(reference)],
		role: "user" as const,
	};
	const created = await persistence.store.createSession({
		agent: agentId("build"),
		id: sessionId,
		message,
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("delete-gc-boundary-turn"),
	});
	expect(created.writeOutcome).toMatchObject({ kind: "committed" });
	watchDeletion = true;
	const gateEntered = Promise.withResolvers<void>();
	const releaseGate = Promise.withResolvers<void>();
	const gate = withSessionCatalogLifecycleGate(logRoot, async () => {
		gateEntered.resolve();
		await releaseGate.promise;
	});
	await gateEntered.promise;
	let deletionOperation: Promise<unknown> | undefined;
	let collectionOperation: Promise<AttachmentMaintenanceReport> | undefined;
	try {
		const collecting = persistence.attachmentStore.collect({
			liveAttachmentIds: [],
			safetyWindowMs: 0,
		});
		collectionOperation = collecting;
		await Bun.sleep(20);
		const deleting = persistence.store.deleteSession(sessionId);
		deletionOperation = deleting;
		const deletionStayedBehindGate = await Promise.race([
			deletedRecordWritten.promise.then(() => false),
			Bun.sleep(20).then(() => true),
		]);
		expect(deletionStayedBehindGate).toBe(true);
		const logPath = path.join(logRoot, sessionId, "session.jsonl");
		expect(await Bun.file(logPath).text()).not.toContain(
			'"type":"session.deleted"'
		);
		expect(await Bun.file(logPath).exists()).toBe(true);
		releaseGate.resolve();
		await gate;
		await deletedRecordWritten.promise;
		expect(await collecting).toMatchObject({ reclaimedCount: 0 });
		expect(await deleting).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		const blobPath = path.join(
			testRoot,
			"attachments",
			"v1",
			reference.attachmentId.slice(3, 5),
			reference.attachmentId.slice(5, 7),
			`${reference.attachmentId}.blob`
		);
		expect(await Bun.file(blobPath).exists()).toBe(true);
		expect(
			await persistence.attachmentStore.collect({
				liveAttachmentIds: [],
				safetyWindowMs: 0,
			})
		).toMatchObject({ reclaimedCount: 1 });
		expect(await Bun.file(blobPath).exists()).toBe(false);
	} finally {
		releaseGate.resolve();
		await gate;
		await deletionOperation?.catch(() => undefined);
		await collectionOperation?.catch(() => undefined);
		persistence.close();
	}
});

test("public Host history hydrates accepted attachments from authoritative references after the attachment catalog is lost", async () => {
	const testRoot = path.join(root, "host-attachment-catalog-rebuild");
	const testWorkspace = path.join(testRoot, "workspace");
	await fs.mkdir(testWorkspace, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const attachmentBytes = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
	]);
	const attachmentDataUrl = `data:image/png;base64,${attachmentBytes.toBase64()}`;
	const attachmentRoot = path.join(testRoot, "attachments");
	let blobSyncedBeforeReference = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			const text = new TextDecoder().decode(
				bytes.subarray(offset, offset + length)
			);
			if (
				filePath.endsWith("session.jsonl") &&
				text.includes('"type":"attachment-reference"')
			) {
				const attachmentId = ATTACHMENT_ID_PATTERN.exec(text)?.[1];
				if (attachmentId === undefined) {
					throw new Error("The durable attachment reference omitted its ID.");
				}
				const blobPath = path.join(
					attachmentRoot,
					"v1",
					attachmentId.slice(3, 5),
					attachmentId.slice(5, 7),
					`${attachmentId}.blob`
				);
				expect(await Bun.file(blobPath).bytes()).toEqual(attachmentBytes);
				blobSyncedBeforeReference = true;
			}
			return (await handle.write(bytes, offset, length, position)).bytesWritten;
		},
	};
	const recorder = createFakeProviderRecorder();
	let sessionId: SessionId | undefined;
	const firstPersistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace,
		fileIo
	);
	const firstServices = await openSessionServices({
		policy: { cwd: testWorkspace, databasePath, workspace: testWorkspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => firstPersistence.store,
		},
	});
	try {
		const created = await firstServices.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		sessionId = created.id;
		const host = await firstServices.capabilities
			.getSessionHostManager()
			.openHost({
				capabilities: firstServices.capabilities,
				autoContinue: false,
				sessionId: created.id,
			});
		try {
			const terminal = Promise.withResolvers<void>();
			const unsubscribe = host.onEvent((event) => {
				if (isTerminalAgentTurnEvent(event)) {
					terminal.resolve();
				}
			});
			const outcome = await host.agentSession.send({
				agent: agentId("build"),
				files: [
					{
						filename: "diagram.png",
						mediaType: "image/png",
						type: "file",
						url: attachmentDataUrl,
					},
				],
				maximumModelSteps: 0,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				userText: "Remember this image.",
			});
			expect(outcome.rejected).toBe(false);
			await Promise.race([
				terminal.promise,
				Bun.sleep(5000).then(() => {
					throw new Error("The image turn did not reach a terminal event.");
				}),
			]);
			unsubscribe();
		} finally {
			await host.shutdown();
		}
	} finally {
		await firstServices.shutdown();
		firstPersistence.close();
	}

	expect(blobSyncedBeforeReference).toBe(true);
	if (sessionId === undefined) {
		throw new Error("The attachment test Session was not created.");
	}
	const reopenedPersistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	for (const record of reopenedPersistence.attachmentRepository.list()) {
		reopenedPersistence.attachmentRepository.delete(record.attachmentId);
	}
	const reopenedServices = await openSessionServices({
		policy: { cwd: testWorkspace, databasePath, workspace: testWorkspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => reopenedPersistence.store,
		},
	});
	try {
		const host = await reopenedServices.capabilities
			.getSessionHostManager()
			.openHost({
				capabilities: reopenedServices.capabilities,
				autoContinue: false,
				sessionId,
			});
		try {
			const records =
				await reopenedServices.store.listSessionRecords(sessionId);
			const hydrated = await reopenedServices.store.hydrateAttachments(
				projectSessionRecords(records),
				{ purpose: "model" }
			);
			expect(JSON.stringify(hydrated)).toContain(attachmentDataUrl);
			expect(reopenedPersistence.attachmentRepository.list()).toHaveLength(1);
		} finally {
			await host.shutdown();
		}
	} finally {
		await reopenedServices.shutdown();
		reopenedPersistence.close();
	}
});

test("a blob sync failure rejects the public Host input before it is acknowledged or referenced", async () => {
	const testRoot = path.join(root, "host-attachment-sync-fault");
	const testWorkspace = path.join(testRoot, "workspace");
	await fs.mkdir(testWorkspace, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const recorder = createFakeProviderRecorder();
	let syncAttempts = 0;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace,
		{},
		async () => {
			syncAttempts += 1;
			throw new Error("injected attachment blob sync failure");
		}
	);
	const services = await openSessionServices({
		policy: {
			cwd: testWorkspace,
			databasePath,
			workspace: testWorkspace,
		},
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => persistence.store,
		},
	});
	try {
		const created = await services.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		const host = await services.capabilities.getSessionHostManager().openHost({
			capabilities: services.capabilities,
			autoContinue: false,
			sessionId: created.id,
		});
		try {
			const outcome = await host.agentSession.send({
				agent: agentId("build"),
				files: [
					{
						filename: "failed-sync.png",
						mediaType: "image/png",
						type: "file",
						url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
					},
				],
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				userText: "Do not accept this attachment before it is durable.",
			});

			expect(outcome).toMatchObject({
				rejected: true,
				reason: "Attachment data could not be stored.",
			});
			expect(syncAttempts).toBe(1);
			expect(recorder.requests).toEqual([]);
			expect(await services.store.listSessionRecords(created.id)).toEqual([]);
			const log = await Bun.file(
				path.join(
					resolveLocalSessionLogRoot(databasePath),
					created.id,
					"session.jsonl"
				)
			).text();
			expect(log).not.toContain("attachment-reference");
			expect(persistence.attachmentRepository.list()).toEqual([]);
		} finally {
			await host.shutdown();
		}
	} finally {
		await services.shutdown();
		persistence.close();
	}
});

test("a projection failure during a tool batch keeps its completed side effect and stops the next model dispatch", async () => {
	const testRoot = path.join(
		process.cwd(),
		"packages/coding-agent/test",
		`session-jsonl-tool-projection-${crypto.randomUUID()}`
	);
	workspaceToolFixtures.push(testRoot);
	const testWorkspace = testRoot;
	await fs.mkdir(testWorkspace, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const firstSideEffectPath = path.join(
		testWorkspace,
		"completed-tool-one.txt"
	);
	const secondSideEffectPath = path.join(
		testWorkspace,
		"completed-tool-two.txt"
	);
	const recorder = createFakeProviderRecorder();
	let modelDispatches = 0;
	recorder.stepScript = async function* () {
		modelDispatches += 1;
		if (modelDispatches === 1) {
			yield {
				input: {
					content: "The first completed Tool side effect must remain visible.",
					expectedVersion: null,
					path: firstSideEffectPath,
				},
				toolCallId: "projection-fault-write-one",
				toolName: "write",
				type: "tool-call",
			};
			yield {
				input: {
					content: "The second completed Tool side effect must remain visible.",
					expectedVersion: null,
					path: secondSideEffectPath,
				},
				toolCallId: "projection-fault-write-two",
				toolName: "write",
				type: "tool-call",
			};
		} else {
			yield { delta: "Unexpected follow-up dispatch.", type: "text-delta" };
		}
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	const services = await openSessionServices({
		policy: {
			cwd: testWorkspace,
			databasePath,
			workspace: testWorkspace,
		},
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => persistence.store,
		},
	});
	try {
		const created = await services.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_tool_checkpoint_projection
			BEFORE INSERT ON session_record
			WHEN NEW.outcome_json = '{"kind":"tool"}'
			BEGIN
				SELECT RAISE(ABORT, 'injected tool projection failure');
			END;
		`);
		const host = await services.capabilities.getSessionHostManager().openHost({
			capabilities: services.capabilities,
			autoContinue: false,
			sessionId: created.id,
		});
		try {
			const outcome = await host.agentSession.send({
				agent: agentId("build"),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				userText: "Run both completed tools before the next model dispatch.",
			});
			expect(outcome.rejected).toBe(false);
			expect(modelDispatches).toBe(1);
			expect(await Bun.file(firstSideEffectPath).text()).toBe(
				"The first completed Tool side effect must remain visible."
			);
			expect(await Bun.file(secondSideEffectPath).text()).toBe(
				"The second completed Tool side effect must remain visible."
			);
			expect(host.getSnapshot().projectionBlocked).toBe(true);
			expect(host.getSnapshot().turnActive).toBe(false);
			expect(host.getSnapshot().error).toMatchObject({
				code: "session_projection_unavailable",
			});
			expect(JSON.stringify(host.getSnapshot().transcript)).toContain(
				"The first completed Tool side effect must remain visible."
			);
			expect(JSON.stringify(host.getSnapshot().transcript)).toContain(
				"The second completed Tool side effect must remain visible."
			);

			const logEntries = (
				await Bun.file(
					path.join(
						resolveLocalSessionLogRoot(databasePath),
						created.id,
						"session.jsonl"
					)
				).text()
			)
				.trimEnd()
				.split("\n")
				.map(
					(line) =>
						JSON.parse(line) as {
							payload?: {
								record?: { outcome?: { kind?: string } };
							};
							type: string;
						}
				);
			const toolRecords = logEntries.filter(
				({ payload, type }) =>
					type === "record.committed" &&
					payload?.record?.outcome?.kind === "tool"
			);
			expect(toolRecords).toHaveLength(2);
			expect(JSON.stringify(toolRecords)).toContain('"kind":"success"');
			expect(JSON.stringify(toolRecords)).toContain(
				"The first completed Tool side effect must remain visible."
			);
			expect(JSON.stringify(toolRecords)).toContain(
				"The second completed Tool side effect must remain visible."
			);
		} finally {
			await host.shutdown();
		}
	} finally {
		persistence.projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_tool_checkpoint_projection"
		);
		await services.shutdown();
		persistence.close();
	}
});

test("public Host continuation reopens a completed Tool result without rerunning the Tool", async () => {
	const testRoot = path.join(
		process.cwd(),
		"packages/coding-agent/test",
		`session-jsonl-tool-${crypto.randomUUID()}`
	);
	workspaceToolFixtures.push(testRoot);
	const testWorkspace = process.cwd();
	const checkpointPath = path.join(testRoot, "checkpoint.txt");
	await fs.mkdir(testRoot, { recursive: true });
	await Bun.write(checkpointPath, "durable tool output");
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const recorder = createFakeProviderRecorder();
	const previousScript = recorder.stepScript;
	let modelCalls = 0;
	let toolCalls = 0;
	const toolResults: string[] = [];
	recorder.stepScript = async function* (request) {
		modelCalls += 1;
		const results = request.messages
			.flatMap((message) => message.content)
			.filter((part) => part.type === "tool-result");
		if (results.length > 0) {
			toolResults.push(JSON.stringify(results));
		}
		if (modelCalls === 1) {
			toolCalls += 1;
			yield {
				input: { path: checkpointPath },
				toolCallId: "reopen-read-call",
				toolName: "read",
				type: "tool-call",
			};
		} else {
			yield {
				delta: "The checkpointed tool result is available.",
				type: "text-delta",
			};
		}
		yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
		yield { type: "finish" };
	};
	let sessionId: SessionId | undefined;
	const firstPersistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	const firstServices = await openSessionServices({
		policy: { cwd: testWorkspace, databasePath, workspace: testWorkspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => firstPersistence.store,
		},
	});
	try {
		const created = await firstServices.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		sessionId = created.id;
		const host = await firstServices.capabilities
			.getSessionHostManager()
			.openHost({
				capabilities: firstServices.capabilities,
				autoContinue: false,
				sessionId,
			});
		try {
			const completed = Promise.withResolvers<void>();
			const unsubscribe = host.onEvent((event) => {
				if (isTerminalAgentTurnEvent(event)) {
					completed.resolve();
				}
			});
			const outcome = await host.agentSession.send({
				agent: agentId("build"),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				userText: "Read the checkpoint file.",
			});
			expect(outcome.rejected).toBe(false);
			await Promise.race([
				completed.promise,
				Bun.sleep(5000).then(() => {
					throw new Error("The Tool turn did not reach a terminal event.");
				}),
			]);
			unsubscribe();
		} finally {
			await host.shutdown();
		}
	} finally {
		await firstServices.shutdown();
		firstPersistence.close();
	}

	if (sessionId === undefined) {
		throw new Error("The Tool result test Session was not created.");
	}
	const reopenedPersistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	const reopenedServices = await openSessionServices({
		policy: { cwd: testWorkspace, databasePath, workspace: testWorkspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => reopenedPersistence.store,
		},
	});
	try {
		const host = await reopenedServices.capabilities
			.getSessionHostManager()
			.openHost({
				capabilities: reopenedServices.capabilities,
				autoContinue: false,
				sessionId,
			});
		try {
			expect(JSON.stringify(host.getSnapshot().transcript)).toContain(
				"durable tool output"
			);
			const completed = Promise.withResolvers<void>();
			const unsubscribe = host.onEvent((event) => {
				if (isTerminalAgentTurnEvent(event)) {
					completed.resolve();
				}
			});
			const outcome = await host.agentSession.send({
				agent: agentId("build"),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
				userText: "Use the stored result to continue.",
			});
			expect(outcome.rejected).toBe(false);
			await Promise.race([
				completed.promise,
				Bun.sleep(5000).then(() => {
					throw new Error("The reopened turn did not reach a terminal event.");
				}),
			]);
			unsubscribe();
		} finally {
			await host.shutdown();
		}
	} finally {
		await reopenedServices.shutdown();
		reopenedPersistence.close();
		recorder.stepScript = previousScript;
	}
	expect(toolCalls).toBe(1);
	expect(modelCalls).toBe(3);
	expect(toolResults.length).toBeGreaterThanOrEqual(2);
	expect(
		toolResults.every((result) => result.includes("durable tool output"))
	).toBe(true);
});

test("Session creation acquires its writer before publishing initial attachments", async () => {
	const testRoot = path.join(root, "sdk-create-attachment-writer-order");
	const testWorkspace = path.join(testRoot, "workspace");
	const databasePath = path.join(testRoot, "sessions.sqlite");
	await fs.mkdir(testWorkspace, { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	const otherPersistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	const sessionId = toSessionId("writer-ordered-attachment-session");
	const input = {
		agent: agentId("build"),
		id: sessionId,
		message: createSessionUserMessage(
			"Create with an image.",
			undefined,
			[],
			[
				{
					filename: "writer-ordered.png",
					mediaType: "image/png",
					type: "file" as const,
					url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
				},
			]
		),
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("writer-ordered-attachment-session"),
	};
	const writer = await otherPersistence.store.acquireSessionWriter(sessionId);
	try {
		const rejected =
			await persistence.store.createSessionWithExternalizedMessage(input);
		expect(rejected.writeOutcome).toMatchObject({
			kind: "not-committed",
			error: { code: "session_in_use" },
		});
		expect(persistence.attachmentRepository.list()).toEqual([]);
	} finally {
		await writer.release();
	}

	try {
		const created =
			await persistence.store.createSessionWithExternalizedMessage(input);
		expect(created.writeOutcome.kind).toBe("committed");
		expect(persistence.attachmentRepository.list()).toHaveLength(1);
	} finally {
		persistence.close();
		otherPersistence.close();
	}
});

test("a not-committed Session creation releases its attachment for same-process collection", async () => {
	const testRoot = path.join(root, "sdk-create-attachment-not-committed");
	const testWorkspace = path.join(testRoot, "workspace");
	const databasePath = path.join(testRoot, "sessions.sqlite");
	await fs.mkdir(testWorkspace, { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace,
		{
			write: async (filePath, handle, bytes, offset, length, position) => {
				if (filePath.includes(`${path.sep}.staging${path.sep}`)) {
					throw new Error("injected Session log staging failure");
				}
				return (await handle.write(bytes, offset, length, position))
					.bytesWritten;
			},
		}
	);
	const sessionId = toSessionId("not-committed-attachment-session");
	try {
		const creation =
			await persistence.store.createSessionWithExternalizedMessage({
				agent: agentId("build"),
				id: sessionId,
				message: createSessionUserMessage(
					"Keep this image.",
					undefined,
					[],
					[
						{
							filename: "not-committed.png",
							mediaType: "image/png",
							type: "file",
							url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
						},
					]
				),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("create-attachment-not-committed"),
			});

		expect(creation.writeOutcome).toMatchObject({
			kind: "not-committed",
			error: { code: "session_log_write_not_committed" },
		});
		expect(await persistence.store.collectAttachments(0)).toMatchObject({
			reclaimedCount: 1,
		});
		expect(persistence.attachmentRepository.list()).toEqual([]);
	} finally {
		persistence.close();
	}
});

test("a failed Session creation releases only its own shared attachment owner", async () => {
	const testRoot = path.join(
		root,
		"sdk-create-shared-attachment-not-committed"
	);
	const testWorkspace = path.join(testRoot, "workspace");
	const foreignWorkspace = path.join(testRoot, "foreign-workspace");
	const databasePath = path.join(testRoot, "sessions.sqlite");
	await fs.mkdir(testWorkspace, { recursive: true });
	await fs.mkdir(foreignWorkspace, { recursive: true });
	const foreignPersistence = createSessionJsonlTestPersistence(
		databasePath,
		foreignWorkspace
	);
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		testWorkspace
	);
	const sessionId = toSessionId("foreign-shared-attachment-session");
	let releaseFirstOwner: (() => Promise<void>) | undefined;
	try {
		await foreignPersistence.store.createEmptySession({ id: sessionId });
		const message = createSessionUserMessage(
			"Keep this shared image.",
			undefined,
			[],
			[
				{
					filename: "shared.png",
					mediaType: "image/png",
					type: "file",
					url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
				},
			]
		);
		const firstOwner =
			await persistence.attachmentStore.externalizeMessagesWithLease(
				[message],
				undefined,
				{ rejectInvalid: true }
			);
		releaseFirstOwner = firstOwner.release;
		const attachmentId = firstOwner.messages[0]?.parts
			.map((part) => getAttachmentReference(part))
			.find((reference) => reference !== null)?.attachmentId;
		if (attachmentId === undefined) {
			throw new Error("The shared attachment was not externalized.");
		}

		const creation =
			await persistence.store.createSessionWithExternalizedMessage({
				agent: agentId("build"),
				id: sessionId,
				message,
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId("create-shared-attachment-not-committed"),
			});
		expect(creation.writeOutcome.kind).toBe("not-committed");
		expect(await persistence.store.collectAttachments(0)).toMatchObject({
			reclaimedCount: 0,
		});

		await firstOwner.release();
		releaseFirstOwner = undefined;
		expect(await persistence.store.collectAttachments(0)).toMatchObject({
			reclaimedCount: 1,
		});
	} finally {
		await releaseFirstOwner?.();
		persistence.close();
		foreignPersistence.close();
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

test("reusing a Session creation ID with a different explicit timestamp conflicts", async () => {
	const databasePath = path.join(root, "sdk-create-timestamp-conflict.sqlite");
	const sessionId = toSessionId("create-timestamp-conflict-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const firstCreatedAt = new Date("2026-10-31T10:00:00.000Z");

	try {
		const created = await persistence.store.createEmptySession({
			createdAt: firstCreatedAt,
			id: sessionId,
		});
		const conflict = await persistence.store.createEmptySession({
			createdAt: new Date("2026-10-31T11:00:00.000Z"),
			id: sessionId,
		});

		expect(created.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(conflict.writeOutcome).toMatchObject({
			kind: "not-committed",
			error: { code: "session_operation_conflict" },
		});
		expect(await persistence.store.getSession(sessionId)).toMatchObject({
			createdAt: firstCreatedAt,
		});
	} finally {
		persistence.close();
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

test("a Session GC started before a prompt-history commit must preserve its attachment", async () => {
	const testDirectory = path.join(root, "prompt-history-attachment-gc-race");
	await fs.mkdir(testDirectory, { recursive: true });
	const databasePath = path.join(testDirectory, "sessions.sqlite");
	const logRoot = path.join(testDirectory, "session-logs");
	const attachmentRoot = path.join(testDirectory, "attachments");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const underlyingAttachments = createSessionAttachmentStore({
		lifecycleRoot: logRoot,
		repository: createMemoryAttachmentMetadataRepository(),
		root: attachmentRoot,
	});
	const collectionStarted = Promise.withResolvers<void>();
	const releaseCollection = Promise.withResolvers<void>();
	let blockFirstCollection = true;
	const attachments: SessionAttachmentStore = {
		...underlyingAttachments,
		collect: async (input) => {
			// Pause after Drizzle supplies liveness but before collection enters its lifecycle gate.
			if (blockFirstCollection) {
				blockFirstCollection = false;
				collectionStarted.resolve();
				await releaseCollection.promise;
			}
			return underlyingAttachments.collect(input);
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		attachmentRoot,
		attachmentStore: attachments,
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot);
	let collection: Promise<AttachmentMaintenanceReport> | undefined;

	try {
		const pendingCollection = store.collectAttachments(0);
		collection = pendingCollection;
		await collectionStarted.promise;

		await store.recordPrompt({
			files: [
				{
					filename: "prompt.png",
					mediaType: "image/png",
					type: "file",
					url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
				},
			],
			text: "Keep this prompt attachment.",
		});
		const [historyEntry] = await store.getPromptHistory();
		const reference = getAttachmentReference(historyEntry?.files[0]);
		if (reference === null || reference === undefined) {
			throw new Error(
				"The committed prompt-history attachment was not stored."
			);
		}

		releaseCollection.resolve();
		await expect(pendingCollection).resolves.toMatchObject({
			reclaimedCount: 0,
		});
		await expect(
			underlyingAttachments.resolve(reference)
		).resolves.toMatchObject({
			availability: "available",
		});
	} finally {
		releaseCollection.resolve();
		await collection?.catch(() => undefined);
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("prompt-history migration cannot release a staging pin after GC snapshots old liveness", async () => {
	const testDirectory = path.join(
		root,
		"prompt-history-migration-attachment-gc-race"
	);
	await fs.mkdir(testDirectory, { recursive: true });
	const databasePath = path.join(testDirectory, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const attachmentRoot = path.join(testDirectory, "attachments");
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const underlyingAttachments = createSessionAttachmentStore({
		lifecycleRoot: logRoot,
		repository: createMemoryAttachmentMetadataRepository(),
		root: attachmentRoot,
	});
	const externalizationReady = Promise.withResolvers<void>();
	const allowMigrationCommit = Promise.withResolvers<void>();
	const livenessSnapshotted = Promise.withResolvers<void>();
	const allowLivenessReturn = Promise.withResolvers<void>();
	const attachments: SessionAttachmentStore = {
		...underlyingAttachments,
		collect: async (input) =>
			underlyingAttachments.collect({
				...input,
				liveAttachmentIds: async () => {
					const liveIds =
						typeof input.liveAttachmentIds === "function"
							? await input.liveAttachmentIds()
							: input.liveAttachmentIds;
					const livenessSnapshot = [...liveIds];
					expect(livenessSnapshot).toEqual([]);
					livenessSnapshotted.resolve();
					await allowLivenessReturn.promise;
					return livenessSnapshot;
				},
			}),
		externalizeMessagesWithLease: async (messages, signal, options) => {
			const lease = await underlyingAttachments.externalizeMessagesWithLease(
				messages,
				signal,
				options
			);
			externalizationReady.resolve();
			await allowMigrationCommit.promise;
			return lease;
		},
	};
	const projectionStore = createDrizzleSessionStore(projection.db, {
		attachmentRoot,
		attachmentStore: attachments,
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot);
	const inlineFile = {
		filename: "migrated.png",
		mediaType: "image/png",
		type: "file",
		url: `data:image/png;base64,${PNG_BYTES.toBase64()}`,
	};
	operational.sqlite
		.query(
			"INSERT INTO prompt_history (prompt, entry_json, created_at) VALUES (?, ?, ?)"
		)
		.run(
			"Keep this migrated image.",
			JSON.stringify({ files: [inlineFile] }),
			Date.now()
		);
	let migration: Promise<PromptHistoryEntry[]> | undefined;
	let collection: Promise<AttachmentMaintenanceReport> | undefined;

	try {
		migration = store.getPromptHistory();
		await externalizationReady.promise;
		const pinDirectory = path.join(
			testDirectory,
			"session-control",
			"attachment-pins"
		);
		expect(await fs.readdir(pinDirectory)).toHaveLength(1);

		collection = store.collectAttachments(0);
		void collection.catch(() => undefined);
		await livenessSnapshotted.promise;
		expect(await fs.readdir(pinDirectory)).toHaveLength(1);

		// Migration's durable transaction and lease release are outside the catalog gate.
		allowMigrationCommit.resolve();
		const migrated = await migration;
		const [entry] = migrated;
		const reference = getAttachmentReference(entry?.files[0]);
		if (reference === null || reference === undefined) {
			throw new Error(
				"Prompt-history migration did not persist its attachment."
			);
		}
		expect(await fs.readdir(pinDirectory)).toHaveLength(0);
		const persistedHistory = operational.sqlite
			.query("SELECT entry_json FROM prompt_history")
			.get() as { entry_json: string };
		expect(persistedHistory.entry_json).toContain(reference.attachmentId);

		allowLivenessReturn.resolve();
		await expect(collection).resolves.toMatchObject({ reclaimedCount: 0 });
		await expect(
			underlyingAttachments.resolve(reference)
		).resolves.toMatchObject({ availability: "available" });
	} finally {
		allowMigrationCommit.resolve();
		allowLivenessReturn.resolve();
		await migration?.catch(() => undefined);
		await collection?.catch(() => undefined);
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
		lifecycleRoot: logRoot,
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
	const referenceLease = await attachments.ingest({
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		filename: "referenced.png",
		mediaType: "image/png",
	});
	const reference = referenceLease.reference;
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
		const publishedLog = await readUtf8File(
			path.join(logRoot, sessionId, "session.jsonl")
		);
		expect(publishedLog).toContain(reference.attachmentId);
		expect(publishedLog).toContain('"type":"attachment-reference"');
		await referenceLease.release();
		await expect(
			attachments.collect({ liveAttachmentIds: [], safetyWindowMs: 0 })
		).resolves.toMatchObject({ reclaimedCount: 0 });
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

test("a stale projection record cannot keep a deleted-log attachment alive", async () => {
	const testDirectory = path.join(root, "stale-attachment-projection");
	await fs.mkdir(testDirectory, { recursive: true });
	const databasePath = path.join(testDirectory, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionId = toSessionId("stale-attachment-projection-session");
	const referenceLease = await persistence.attachmentStore.ingest({
		bytes: PNG_BYTES,
		filename: "stale-projection.png",
		mediaType: "image/png",
	});
	const reference = referenceLease.reference;
	const record = buildUserSessionRecord({
		agentId: agentId("build"),
		message: {
			id: sessionMessageId("stale-attachment-user"),
			parts: [
				{
					text: "This reference will outlive its log only in SQLite.",
					type: "text",
				},
				attachmentReferenceToFilePart(reference),
			],
			role: "user",
		},
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("stale-attachment-turn"),
	});
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		expect(
			await persistence.store.commitSessionRecord({ record, sessionId })
		).toMatchObject({ kind: "committed", projection: "ready" });
		await referenceLease.release();
		await persistence.attachmentStore.retain([reference.attachmentId]);
		await expect(
			persistence.store.deleteSession(sessionId)
		).resolves.toMatchObject({
			kind: "committed",
		});
		expect(
			await Bun.file(path.join(logRoot, sessionId, "session.jsonl")).exists()
		).toBe(false);
		await persistence.attachmentStore.release([reference.attachmentId]);

		// Model the crash window after log removal but before projection cleanup.
		const projectionNow = Date.now();
		persistence.projection.sqlite
			.query(
				`INSERT INTO session
				(id, title, pinned, created_at, updated_at, last_message_at, model_json, thinking_level, edit_mode)
				VALUES (?, ?, 0, ?, ?, ?, ?, NULL, 'hashline')`
			)
			.run(
				sessionId,
				"Stale projection",
				projectionNow,
				projectionNow,
				projectionNow,
				JSON.stringify(DEFAULT_PROVIDER_MODEL_SELECTION)
			);
		persistence.projection.sqlite
			.query(
				`INSERT INTO session_record
				(record_id, session_id, turn_id, agent_id, model_json, outcome_json, messages_json, version, position, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
			)
			.run(
				record.id,
				sessionId,
				record.turnId,
				record.agentId,
				JSON.stringify(record.model),
				JSON.stringify(record.outcome),
				JSON.stringify(record.messages),
				record.version,
				projectionNow
			);

		const gcStore = createDrizzleSessionStore(persistence.projection.db, {
			attachmentStore: persistence.attachmentStore,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		});
		await expect(gcStore.collectAttachments(0)).resolves.toMatchObject({
			reclaimedCount: 1,
		});
		expect(persistence.attachmentRepository.get(reference.attachmentId)).toBe(
			undefined
		);
	} finally {
		persistence.close();
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
			offset: 0,
			sequence: 0,
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
	const recorder = createFakeProviderRecorder();
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(recorder),
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
	const firstRecorder = createFakeProviderRecorder();
	const firstSdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(firstRecorder),
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

	const retryRecorder = createFakeProviderRecorder();
	const retrySdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(retryRecorder),
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

test("indeterminate prompt writes retain externalization leases until JSONL reconciliation", async () => {
	const testRoot = path.join(root, "indeterminate-prompt-attachment-lease");
	await fs.mkdir(testRoot, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const sessionId = toSessionId("indeterminate-prompt-lease-session");
	let logPath: string | undefined;
	let failAfterAppendSync = false;
	let logSyncCount = 0;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			sync: async (filePath, handle) => {
				await handle.sync();
				if (filePath === logPath) {
					logSyncCount += 1;
					if (failAfterAppendSync && logSyncCount >= 2) {
						throw new Error("injected prompt log sync failure");
					}
				}
			},
		}
	);
	const sessionCreated = await persistence.store.createEmptySession({
		id: sessionId,
	});
	expect(sessionCreated.writeOutcome.kind).toBe("committed");
	logPath = path.join(await fs.realpath(logRoot), sessionId, "session.jsonl");
	const sourceLease = await persistence.attachmentStore.ingest({
		bytes: PNG_BYTES,
		filename: "indeterminate-prompt.png",
		mediaType: "image/png",
	});
	await sourceLease.release();
	const userMessage = {
		id: sessionMessageId("indeterminate-prompt-lease-message"),
		parts: [attachmentReferenceToFilePart(sourceLease.reference)],
		role: "user" as const,
	};
	const externalization =
		await persistence.attachmentStore.externalizeMessagesWithLease([
			userMessage,
		]);
	const record = buildUserSessionRecord({
		agentId: agentId("build"),
		message: externalization.messages[0] ?? userMessage,
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		turnId: agentTurnId("indeterminate-prompt-lease-turn"),
	});
	const pinDirectory = path.join(
		path.dirname(logRoot),
		"session-control",
		"attachment-pins"
	);
	try {
		failAfterAppendSync = true;
		const outcome = await persistence.store.commitSessionRecord({
			externalizationLease: externalization,
			record,
			sessionId,
		});
		expect(outcome.kind).toBe("indeterminate");
		const pinsAfterWrite = await fs.readdir(pinDirectory);
		expect(pinsAfterWrite.length).toBeGreaterThan(0);

		failAfterAppendSync = false;
		await persistence.store.getSession(sessionId);
		const pinsAfterReconciliation = await fs.readdir(pinDirectory);
		expect(pinsAfterReconciliation).toHaveLength(0);
	} finally {
		failAfterAppendSync = false;
		await externalization.release();
		persistence.close();
	}
});

test("indeterminate compaction writes retain externalization leases until JSONL reconciliation", async () => {
	const testRoot = path.join(root, "indeterminate-compaction-attachment-lease");
	await fs.mkdir(testRoot, { recursive: true });
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const sessionId = toSessionId("indeterminate-compaction-lease-session");
	let logPath: string | undefined;
	let failAfterAppendSync = false;
	let failOnLogSyncCount: number | undefined;
	let logSyncCount = 0;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			sync: async (filePath, handle) => {
				await handle.sync();
				if (filePath === logPath) {
					logSyncCount += 1;
					if (
						failAfterAppendSync &&
						failOnLogSyncCount !== undefined &&
						logSyncCount >= failOnLogSyncCount
					) {
						throw new Error("injected compaction log sync failure");
					}
				}
			},
		}
	);
	await persistence.store.createEmptySession({ id: sessionId });
	logPath = path.join(await fs.realpath(logRoot), sessionId, "session.jsonl");
	const sourceLease = await persistence.attachmentStore.ingest({
		bytes: PNG_BYTES,
		filename: "indeterminate-compaction.png",
		mediaType: "image/png",
	});
	await sourceLease.release();
	const messageId = sessionMessageId("indeterminate-compaction-message");
	const message = {
		id: messageId,
		parts: [attachmentReferenceToFilePart(sourceLease.reference)],
		role: "user" as const,
	};
	const recordExternalization =
		await persistence.attachmentStore.externalizeMessagesWithLease([message]);
	try {
		const record = buildUserSessionRecord({
			agentId: agentId("indeterminate-compaction-agent"),
			message: recordExternalization.messages[0] ?? message,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("indeterminate-compaction-record"),
		});
		const recordWrite = await persistence.store.commitSessionRecord({
			externalizationLease: recordExternalization,
			record,
			sessionId,
		});
		expect(recordWrite.kind).toBe("committed");
	} finally {
		await recordExternalization.release();
	}
	const externalization =
		await persistence.attachmentStore.externalizeMessagesWithLease([message]);
	const input: AppendSessionCompactionInput = {
		externalizationLease: externalization,
		firstKeptUiMessageId: messageId,
		sessionId,
		summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
		summary: {
			attachments: [],
			coveredMessageIds: [messageId],
			formatVersion: 1,
			text: "The original image remains protected until this write is resolved.",
		},
		throughMessageUiId: messageId,
		tokensBefore: 100,
		estimatedTokensAfter: 50,
		trigger: "manual",
		id: compactionId("indeterminate-compaction-lease-entry"),
	};
	const pinDirectory = path.join(
		path.dirname(logRoot),
		"session-control",
		"attachment-pins"
	);
	try {
		failOnLogSyncCount = logSyncCount + 3;
		failAfterAppendSync = true;
		const result = await persistence.store.appendCompaction(input);
		expect(result.writeOutcome.kind).toBe("indeterminate");
		expect(await fs.readdir(pinDirectory)).not.toHaveLength(0);

		failAfterAppendSync = false;
		failOnLogSyncCount = undefined;
		await persistence.store.getLatestCompaction(sessionId);
		expect(await fs.readdir(pinDirectory)).toHaveLength(0);
	} finally {
		failAfterAppendSync = false;
		await externalization.release();
		persistence.close();
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
			if (
				failReceiptWrite &&
				filePath.includes(`${operationIdFileStem(operationId)}.json.`)
			) {
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
			`${operationIdFileStem(operationId)}.json`
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

test("compaction retry rejects changed payload before repairing the incomplete append", async () => {
	const databasePath = path.join(root, "sdk-compaction-tail-retry.sqlite");
	const sessionId = toSessionId("compaction-tail-retry-session");
	let logPath: string | undefined;
	let failCompactionAppend = false;
	let injectedPartialWrite = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (
				failCompactionAppend &&
				!injectedPartialWrite &&
				filePath === logPath
			) {
				injectedPartialWrite = true;
				failCompactionAppend = false;
				await handle.write(
					bytes,
					offset,
					Math.min(19, length),
					position + offset
				);
				const error = new Error("injected compaction ENOSPC");
				Reflect.set(error, "code", "ENOSPC");
				throw error;
			}
			return (await handle.write(bytes, offset, length, position + offset))
				.bytesWritten;
		},
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		fileIo
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		logPath = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			sessionId,
			"session.jsonl"
		);
		const coveredMessageId = sessionMessageId("compaction-tail-covered");
		const keptMessageId = sessionMessageId("compaction-tail-kept");
		for (const [messageId, text, turn] of [
			[coveredMessageId, "covered history", "covered-turn"],
			[keptMessageId, "kept history", "kept-turn"],
		] as const) {
			const record = buildUserSessionRecord({
				agentId: agentId("compaction-tail-agent"),
				message: createSessionUserMessage(text, undefined, [], [], messageId),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(turn),
			});
			const recordWrite = await persistence.store.commitSessionRecord({
				record,
				sessionId,
			});
			expect(recordWrite).toMatchObject({
				kind: "committed",
				projection: "ready",
			});
		}
		const input: AppendSessionCompactionInput = {
			estimatedTokensAfter: 64,
			firstKeptUiMessageId: keptMessageId,
			id: compactionId("compaction-tail-retry"),
			sessionId,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [coveredMessageId],
				formatVersion: 1,
				text: "Recovered compaction summary.",
			},
			throughMessageUiId: coveredMessageId,
			tokensBefore: 256,
			trigger: "threshold",
		};
		failCompactionAppend = true;
		const uncertain = await persistence.store.appendCompaction(input);
		expect(uncertain.writeOutcome).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
		});
		const pendingIntent = (await Bun.file(
			path.join(root, "session-control", "indeterminate", `${sessionId}.json`)
		).json()) as { sequence: number; timestamp: string };
		const incompleteLog = await Bun.file(logPath).bytes();
		const operationId = `compaction-${input.id}`;
		const quarantinePath = path.join(
			root,
			"session-control",
			"quarantine",
			sessionId,
			`${pendingIntent.sequence}-${operationIdFileStem(operationId)}.partial`
		);
		const conflict = await persistence.store.appendCompaction({
			...input,
			summary: { ...input.summary, text: "Changed retry payload." },
		});
		expect(conflict.writeOutcome).toMatchObject({
			kind: "not-committed",
			error: { code: "session_operation_conflict" },
		});
		expect(await Bun.file(logPath).bytes()).toEqual(incompleteLog);
		expect(await Bun.file(quarantinePath).exists()).toBe(false);
		expect(await Bun.file(`${quarantinePath}.json`).exists()).toBe(false);

		const recovered = await persistence.store.appendCompaction(input);
		expect(recovered.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(recovered.compaction?.createdAt.toISOString()).toBe(
			pendingIntent.timestamp
		);
		expect(await persistence.store.getCompactions(sessionId)).toHaveLength(1);
	} finally {
		persistence.close();
	}
});

test("legacy projection cursors migrate into the ready rebuild generation", async () => {
	const databasePath = path.join(
		root,
		"projection-generation-migration",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const projectionPath = resolveLocalSessionProjectionPath(databasePath);
	const legacyProjection = createDatabase(projectionPath);
	legacyProjection.sqlite.exec(`
		ALTER TABLE session_projection_cursor DROP COLUMN generation;
		INSERT INTO session_projection_cursor (
			session_id, log_id, next_byte_offset, next_sequence, last_hash
		) VALUES ('legacy-projection-session', 'legacy-log', 10, 1, 'legacy-hash');
	`);
	legacyProjection.sqlite.close();

	const operational = createDatabase(databasePath);
	const projection = createDatabase(projectionPath);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const projectionStore = createDrizzleSessionStore(projection.db, {
		operationalDatabase: operational.db,
		sessionLogRoot: logRoot,
		workspaceRoot: workspace,
	});
	const store = createSessionJsonlStore(projectionStore, logRoot);
	try {
		const columns = projection.sqlite
			.query("PRAGMA table_info(session_projection_cursor)")
			.all() as Array<{ name: string }>;
		const cursor = projection.sqlite
			.query(
				"SELECT generation FROM session_projection_cursor WHERE session_id = ?"
			)
			.get("legacy-projection-session") as { generation: number };
		const state = projection.sqlite
			.query(
				"SELECT generation, status FROM session_projection_state WHERE id = 1"
			)
			.get() as { generation: number; status: string };

		expect(columns.some(({ name }) => name === "generation")).toBe(true);
		expect(cursor.generation).toBe(0);
		expect(state).toEqual({ generation: 0, status: "ready" });
		expect(store).toBeDefined();
	} finally {
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("projection rebuild replays published history without clearing operational data", async () => {
	const databasePath = path.join(
		root,
		"projection-rebuild",
		"sdk-projection-rebuild.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-rebuild-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({
			createdAt: new Date("2026-10-31T00:00:00.000Z"),
			id: sessionId,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		const attachmentLease = await persistence.attachmentStore.ingest({
			bytes: PNG_BYTES,
			filename: "projection-rebuild.png",
			mediaType: "image/png",
		});
		const attachmentReference = attachmentLease.reference;
		await attachmentLease.release();
		const coveredMessageId = sessionMessageId("projection-rebuild-covered");
		const keptMessageId = sessionMessageId("projection-rebuild-kept");
		const steeringSubmissionId = toSubmissionId(
			"projection-rebuild-steering-submission"
		);
		for (const [messageId, text, turn] of [
			[coveredMessageId, "covered rebuild history", "covered-rebuild-turn"],
			[keptMessageId, "kept rebuild history", "kept-rebuild-turn"],
		] as const) {
			const isCoveredMessage = messageId === coveredMessageId;
			const record = buildUserSessionRecord({
				agentId: agentId("projection-rebuild-agent"),
				message: createSessionUserMessage(
					text,
					isCoveredMessage
						? {
								agent: agentId("projection-rebuild-agent"),
								model: DEFAULT_PROVIDER_MODEL_SELECTION,
								submissionId: steeringSubmissionId,
								submissionStatus: "pending",
							}
						: undefined,
					[],
					isCoveredMessage
						? [attachmentReferenceToFilePart(attachmentReference)]
						: [],
					messageId
				),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(turn),
			});
			const write = await persistence.store.commitSessionRecord({
				record,
				sessionId,
			});
			if (write.kind !== "committed") {
				throw new Error("A rebuild fixture record failed to commit.");
			}
			if (isCoveredMessage) {
				const status = await persistence.store.updateSessionSubmission({
					messageId,
					recordId: record.id,
					sessionId,
					status: "processing",
					submissionId: steeringSubmissionId,
				});
				if (status.kind !== "committed") {
					throw new Error(
						"A rebuild fixture steering status failed to commit."
					);
				}
			}
		}
		const compactionInput: AppendSessionCompactionInput = {
			estimatedTokensAfter: 32,
			firstKeptUiMessageId: keptMessageId,
			id: compactionId("projection-rebuild-compaction"),
			sessionId,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [coveredMessageId],
				formatVersion: 1,
				text: "Rebuilt projection summary.",
			},
			throughMessageUiId: coveredMessageId,
			tokensBefore: 128,
			trigger: "threshold",
		};
		const compaction =
			await persistence.store.appendCompaction(compactionInput);
		expect(compaction.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		const usageInput = {
			compactionId: compactionInput.id,
			costUsd: 0.25,
			createdAt: new Date("2026-10-31T00:01:00.000Z"),
			id: sessionUsageEntryId("projection-rebuild-usage"),
			kind: "compaction-summary" as const,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId,
			usage: { inputTokens: 40, outputTokens: 5 },
		};
		await persistence.store.createSessionUsageEntry(usageInput);
		const promptHistory: PromptHistoryEntry = {
			files: [],
			text: "Keep this operational prompt history.",
		};
		await persistence.store.recordPrompt(promptHistory);
		const { workspace_id: workspaceId } = persistence.operational.sqlite
			.query(
				"SELECT workspace_id FROM local_session_binding WHERE session_id = ?"
			)
			.get(sessionId) as { workspace_id: string };
		const transactionId = "projection-rebuild-recovery-transaction";
		const artifactId = "projection-rebuild-recovery-artifact";
		const recoveryBytesPath = path.join(
			path.dirname(databasePath),
			"recovery-artifacts",
			artifactId,
			"preserve.bin"
		);
		await Bun.write(recoveryBytesPath, PNG_BYTES);
		persistence.operational.sqlite
			.query(
				"INSERT INTO file_observation (id, session_id, path, file_version, seen_lines_json, snapshot_available, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
			)
			.run(
				"projection-rebuild-observation",
				sessionId,
				"src/observed.ts",
				"file-version-observed",
				"[1,2]",
				0,
				1
			);
		persistence.operational.sqlite
			.query(
				"INSERT INTO file_transaction (id, workspace_id, origin_session_id, status, reason, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
			)
			.run(
				transactionId,
				workspaceId,
				sessionId,
				"blocked",
				"preserve during rebuild",
				1,
				null
			);
		persistence.operational.sqlite
			.query(
				"INSERT INTO file_transaction_path (transaction_id, canonical_path, display_path, original_file_version, new_file_version, original_blob_key, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
			)
			.run(
				transactionId,
				"/workspace/src/observed.ts",
				"src/observed.ts",
				null,
				"file-version-written",
				null,
				"blocked"
			);
		persistence.operational.sqlite
			.query(
				"INSERT INTO recovery_artifact (id, transaction_id, workspace_id, origin_session_id, created_at, pinned) VALUES (?, ?, ?, ?, ?, ?)"
			)
			.run(artifactId, transactionId, workspaceId, sessionId, 1, 1);
		persistence.operational.sqlite
			.query(
				"INSERT INTO recovery_artifact_path (artifact_id, canonical_path, display_path, current_file_version, original_file_version, new_file_version, original_blob_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
			)
			.run(
				artifactId,
				"/workspace/src/observed.ts",
				"src/observed.ts",
				null,
				null,
				"file-version-written",
				null
			);
		persistence.operational.sqlite
			.query(
				"INSERT INTO unresolved_recovery (id, artifact_id, transaction_id, workspace_id, origin_session_id, status, reason, created_at, resolved_at, reconciled_by_session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
			)
			.run(
				"projection-rebuild-unresolved-recovery",
				artifactId,
				transactionId,
				workspaceId,
				sessionId,
				"unresolved",
				"preserve during rebuild",
				1,
				null,
				null
			);
		const readOperationalState = () => ({
			binding: persistence.operational.sqlite
				.query("SELECT * FROM local_session_binding WHERE session_id = ?")
				.get(sessionId),
			fileObservation: persistence.operational.sqlite
				.query("SELECT * FROM file_observation WHERE session_id = ?")
				.get(sessionId),
			fileTransaction: persistence.operational.sqlite
				.query("SELECT * FROM file_transaction WHERE id = ?")
				.get(transactionId),
			fileTransactionPath: persistence.operational.sqlite
				.query("SELECT * FROM file_transaction_path WHERE transaction_id = ?")
				.get(transactionId),
			recoveryArtifact: persistence.operational.sqlite
				.query("SELECT * FROM recovery_artifact WHERE id = ?")
				.get(artifactId),
			recoveryArtifactPath: persistence.operational.sqlite
				.query("SELECT * FROM recovery_artifact_path WHERE artifact_id = ?")
				.get(artifactId),
			unresolvedRecovery: persistence.operational.sqlite
				.query("SELECT * FROM unresolved_recovery WHERE id = ?")
				.get("projection-rebuild-unresolved-recovery"),
		});
		const beforeOperationalState = readOperationalState();
		const beforeAttachmentMetadata = persistence.attachmentRepository.get(
			attachmentReference.attachmentId
		);
		const beforeOperations = persistence.projection.sqlite
			.query(
				"SELECT entry_hash, operation_digest, operation_id, sequence, type FROM session_operation_lookup WHERE session_id = ? ORDER BY sequence"
			)
			.all(sessionId);
		const before = {
			compactions: await persistence.store.getCompactions(sessionId),
			promptHistory: await persistence.store.getPromptHistory(),
			records: await persistence.store.listSessionRecords(sessionId),
			session: await persistence.store.getSession(sessionId),
			usage: await persistence.store.listSessionUsageEntries(sessionId),
		};

		const stagingSessionDirectory = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			".staging",
			"unpublished-session"
		);
		await fs.mkdir(stagingSessionDirectory, { recursive: true });
		await Bun.write(
			path.join(stagingSessionDirectory, "session.jsonl"),
			"not a published Session log"
		);
		persistence.projection.sqlite.exec(
			"DELETE FROM session_compaction; DELETE FROM session_record; DELETE FROM session_usage_entry; DELETE FROM session_operation_lookup; DELETE FROM session; DELETE FROM session_projection_cursor;"
		);
		const rebuilt = await persistence.store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);

		expect(rebuilt.issues).toEqual([]);
		expect(rebuilt.rebuiltSessionIds).toEqual([sessionId]);
		expect({
			compactions: await persistence.store.getCompactions(sessionId),
			promptHistory: await persistence.store.getPromptHistory(),
			records: await persistence.store.listSessionRecords(sessionId),
			session: await persistence.store.getSession(sessionId),
			usage: await persistence.store.listSessionUsageEntries(sessionId),
		}).toEqual(before);
		expect(readOperationalState()).toEqual(beforeOperationalState);
		expect(
			persistence.projection.sqlite
				.query(
					"SELECT entry_hash, operation_digest, operation_id, sequence, type FROM session_operation_lookup WHERE session_id = ? ORDER BY sequence"
				)
				.all(sessionId)
		).toEqual(beforeOperations);
		expect(beforeOperations).toHaveLength(6);
		expect(
			persistence.attachmentRepository.get(attachmentReference.attachmentId)
		).toEqual(beforeAttachmentMetadata);
		expect(await Bun.file(recoveryBytesPath).bytes()).toEqual(PNG_BYTES);
		const rebuiltAgain = await persistence.store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);
		expect(rebuiltAgain.issues).toEqual([]);
		expect(
			persistence.projection.sqlite
				.query(
					"SELECT entry_hash, operation_digest, operation_id, sequence, type FROM session_operation_lookup WHERE session_id = ? ORDER BY sequence"
				)
				.all(sessionId)
		).toEqual(beforeOperations);
		expect(await persistence.store.listSessionUsageEntries(sessionId)).toEqual(
			before.usage
		);
	} finally {
		persistence.close();
	}
});

test("full projection rebuild discovers Sessions across existing workspace bindings", async () => {
	const testRoot = path.join(root, "multi-workspace-projection-rebuild");
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const firstWorkspace = path.join(testRoot, "workspace-one");
	const secondWorkspace = path.join(testRoot, "workspace-two");
	await fs.mkdir(firstWorkspace, { recursive: true });
	await fs.mkdir(secondWorkspace, { recursive: true });
	const firstSessionId = toSessionId("multi-workspace-rebuild-first");
	const secondSessionId = toSessionId("multi-workspace-rebuild-second");
	const firstPersistence = createSessionJsonlTestPersistence(
		databasePath,
		firstWorkspace
	);
	const secondPersistence = createSessionJsonlTestPersistence(
		databasePath,
		secondWorkspace
	);

	try {
		await firstPersistence.store.createEmptySession({ id: firstSessionId });
		await secondPersistence.store.createEmptySession({ id: secondSessionId });
		firstPersistence.projection.sqlite.exec(
			"DELETE FROM session_projection_cursor; DELETE FROM session;"
		);

		const rebuilt = await firstPersistence.store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);

		expect(rebuilt.issues).toEqual([]);
		expect(rebuilt.rebuiltSessionIds).toEqual([
			firstSessionId,
			secondSessionId,
		]);
		expect((await firstPersistence.store.getSession(firstSessionId)).id).toBe(
			firstSessionId
		);
		expect((await secondPersistence.store.getSession(secondSessionId)).id).toBe(
			secondSessionId
		);
		await expect(
			firstPersistence.store.getSession(secondSessionId)
		).rejects.toThrow("Session not found");
	} finally {
		firstPersistence.close();
		secondPersistence.close();
	}
});

test("a targeted projection rebuild refreshes stale-generation sessions before reads", async () => {
	const databasePath = path.join(
		root,
		"targeted-projection-rebuild",
		"sdk-targeted-projection-rebuild.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const firstSessionId = toSessionId("targeted-rebuild-first-session");
	const secondSessionId = toSessionId("targeted-rebuild-second-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: firstSessionId });
		await persistence.store.createEmptySession({ id: secondSessionId });
		await persistence.store.updateSession(secondSessionId, {
			operationId: "targeted-rebuild-title",
			title: "Authoritative title",
		});
		persistence.projection.sqlite
			.query("UPDATE session SET title = ? WHERE id = ?")
			.run("Stale projection title", secondSessionId);

		const rebuilt = await persistence.store.rebuildProjection(
			{ kind: "session", sessionId: firstSessionId },
			async (action) => await action()
		);
		const session = await persistence.store.getSession(secondSessionId);
		const cursor = persistence.projection.sqlite
			.query(
				"SELECT generation FROM session_projection_cursor WHERE session_id = ?"
			)
			.get(secondSessionId) as { generation: number };

		expect(rebuilt).toMatchObject({
			issues: [],
			rebuiltSessionIds: [firstSessionId],
		});
		expect(session.title).toBe("Authoritative title");
		expect(cursor.generation).toBe(rebuilt.generation);
	} finally {
		persistence.close();
	}
});

test("Session history pages keep status and log position at their captured prefix", async () => {
	const databasePath = path.join(
		root,
		"history-page-snapshot",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("history-page-snapshot");
	const submissionId = toSubmissionId("history-page-first-submission");
	const markerPath = path.join(
		path.dirname(resolveLocalSessionLogRoot(databasePath)),
		"session-control",
		"deleted",
		`${sessionId}.json`
	);
	let failDeletionMarkerSync = true;
	let persistenceClosed = false;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			sync: async (filePath, handle) => {
				if (
					failDeletionMarkerSync &&
					filePath.includes(path.join("deleted", `${sessionId}.json.`))
				) {
					failDeletionMarkerSync = false;
					throw new Error("Injected crash before deletion marker sync.");
				}
				await handle.sync();
			},
		}
	);
	const makeRecord = (sequence: number, withSubmission = false) => {
		const messageId = sessionMessageId(`history-page-message-${sequence}`);
		const record = buildUserSessionRecord({
			agentId: agentId("history-page-agent"),
			message: {
				id: messageId,
				...(withSubmission
					? {
							metadata: {
								agent: agentId("history-page-agent"),
								model: DEFAULT_PROVIDER_MODEL_SELECTION,
								submissionId,
								submissionStatus: "pending" as const,
							},
						}
					: {}),
				parts: [{ text: `history record ${sequence}`, type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId(`history-page-turn-${sequence}`),
		});
		return { messageId, record };
	};
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const firstRecord = makeRecord(1, true);
		const secondRecord = makeRecord(2);
		const thirdRecord = makeRecord(3);
		await persistence.store.commitSessionRecord({
			record: firstRecord.record,
			sessionId,
		});
		await persistence.store.commitSessionRecord({
			record: secondRecord.record,
			sessionId,
		});
		await persistence.store.commitSessionRecord({
			record: thirdRecord.record,
			sessionId,
		});

		const firstPage = await persistence.store.readSessionHistoryPage(
			sessionId,
			{
				limit: 2,
			}
		);
		expect(firstPage.records.map(({ id }) => id)).toEqual([
			secondRecord.record.id,
			thirdRecord.record.id,
		]);
		expect(firstPage.nextCursor).toBeString();
		const cursor = firstPage.nextCursor;
		if (cursor === undefined) {
			throw new Error(
				"The first history page omitted its continuation cursor."
			);
		}

		await persistence.store.updateSessionSubmission({
			messageId: firstRecord.messageId,
			recordId: firstRecord.record.id,
			sessionId,
			status: "processed",
			submissionId,
		});
		const appendedRecord = makeRecord(4);
		await persistence.store.commitSessionRecord({
			record: appendedRecord.record,
			sessionId,
		});
		const secondPage = await persistence.store.readSessionHistoryPage(
			sessionId,
			{
				cursor,
			}
		);

		expect(secondPage.readPoint).toBe(firstPage.readPoint);
		expect(secondPage.records.map(({ id }) => id)).toEqual([
			firstRecord.record.id,
		]);
		expect(secondPage.records[0]?.messages[0]?.metadata?.submissionStatus).toBe(
			"pending"
		);
		expect(secondPage.records.map(({ id }) => id)).not.toContain(
			appendedRecord.record.id
		);

		const deletion = await persistence.store.deleteSession(sessionId);
		expect(deletion).toMatchObject({
			kind: "committed",
			projection: "blocked",
		});
		await fs.rm(markerPath, { force: true });
		persistence.close();
		persistenceClosed = true;

		const reopened = createSessionJsonlTestPersistence(databasePath, workspace);
		try {
			const catalog = await reopened.store.listSessionCatalog();
			expect(catalog.sessions.map(({ id }) => id)).not.toContain(sessionId);
			expect(catalog.issues).toEqual([]);
			await expect(
				reopened.store.readSessionHistoryPage(sessionId, { cursor })
			).rejects.toMatchObject({ code: "cursor_expired" });
		} finally {
			reopened.close();
		}
	} finally {
		if (!persistenceClosed) {
			persistence.close();
		}
	}
});

test("Session catalog pages keep ordering and metadata at their captured revision", async () => {
	const databasePath = path.join(
		root,
		"catalog-page-snapshot",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const catalogWorkspace = path.join(root, "catalog-page-workspace");
	await fs.mkdir(catalogWorkspace, { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		catalogWorkspace
	);
	const ids = {
		oldest: toSessionId("catalog-page-oldest"),
		middle: toSessionId("catalog-page-middle"),
		newest: toSessionId("catalog-page-newest"),
		pinned: toSessionId("catalog-page-pinned"),
	};
	try {
		await persistence.store.createEmptySession({
			createdAt: new Date(1000),
			id: ids.oldest,
		});
		await persistence.store.createEmptySession({
			createdAt: new Date(2000),
			id: ids.middle,
		});
		await persistence.store.createEmptySession({
			createdAt: new Date(3000),
			id: ids.newest,
		});
		await persistence.store.createEmptySession({
			createdAt: new Date(500),
			id: ids.pinned,
		});
		await persistence.store.updateSession(ids.pinned, { pinned: true });
		await persistence.store.updateSession(ids.oldest, {
			title: "Before refresh",
		});
		const foreignWorkspace = path.join(root, "catalog-page-foreign-workspace");
		await fs.mkdir(foreignWorkspace, { recursive: true });
		const foreignPersistence = createSessionJsonlTestPersistence(
			databasePath,
			foreignWorkspace
		);
		const foreignId = toSessionId("catalog-page-foreign");
		try {
			await foreignPersistence.store.createEmptySession({
				createdAt: new Date(10_000),
				id: foreignId,
			});
		} finally {
			foreignPersistence.close();
		}

		const firstPage = await persistence.store.listSessionsPage({ limit: 2 });
		expect(firstPage.sessions.map(({ id }) => id)).toEqual([
			ids.pinned,
			ids.newest,
		]);
		expect(firstPage.sessions.map(({ id }) => id)).not.toContain(foreignId);
		expect(firstPage.nextCursor).toBeString();
		const cursor = firstPage.nextCursor;
		if (cursor === undefined) {
			throw new Error(
				"The first catalog page omitted its continuation cursor."
			);
		}

		await persistence.store.updateSession(ids.oldest, {
			pinned: true,
			title: "Changed after the snapshot",
		});
		await persistence.store.updateSession(ids.middle, {
			pinned: true,
			title: "Also changed after the snapshot",
		});
		const secondPage = await persistence.store.listSessionsPage({
			cursor,
			limit: 2,
		});

		expect(secondPage.readPoint).toBe(firstPage.readPoint);
		expect(secondPage.sessions).toMatchObject([
			{ id: ids.middle, pinned: false },
			{ id: ids.oldest, pinned: false, title: "Before refresh" },
		]);
		expect(
			[...firstPage.sessions, ...secondPage.sessions].map(({ id }) => id)
		).toEqual([ids.pinned, ids.newest, ids.middle, ids.oldest]);

		const tieA = toSessionId("catalog-page-tie-a");
		const tieB = toSessionId("catalog-page-tie-b");
		await persistence.store.createEmptySession({
			createdAt: new Date(4000),
			id: tieB,
		});
		await persistence.store.createEmptySession({
			createdAt: new Date(4000),
			id: tieA,
		});
		const refreshedPage = await persistence.store.listSessionsPage({
			limit: 10,
		});
		expect(refreshedPage.sessions.map(({ id }) => id)).toEqual([
			ids.middle,
			ids.oldest,
			ids.pinned,
			tieA,
			tieB,
			ids.newest,
		]);
	} finally {
		persistence.close();
	}
});

test("Session page and statistics queries use scope indexes without temporary sorts", async () => {
	const databasePath = path.join(
		root,
		"session-page-query-plans",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	try {
		const catalogPlan = persistence.projection.sqlite
			.query<{ detail: string }, [string, number, number, number]>(`
				EXPLAIN QUERY PLAN
				SELECT * FROM session_catalog_version
				WHERE workspace_id = ?
					AND valid_from_revision <= ?
					AND (valid_to_revision IS NULL OR valid_to_revision > ?)
				ORDER BY pinned DESC, last_message_at DESC, created_at DESC, session_id ASC
				LIMIT ?
			`)
			.all("workspace", 1, 1, 51)
			.map(({ detail }) => detail)
			.join("\\n");
		const historyPlan = persistence.projection.sqlite
			.query<{ detail: string }, [string, number, number, number, number]>(`
				EXPLAIN QUERY PLAN
				SELECT session_record_version.messages_json, session_record.*,
					session_record_version.source_sequence
				FROM session_record_version
				INNER JOIN session_record
					ON session_record.record_id = session_record_version.record_id
				WHERE session_record_version.session_id = ?
					AND session_record_version.source_sequence <= ?
					AND session_record_version.valid_from_sequence <= ?
					AND (session_record_version.valid_to_sequence IS NULL
						OR session_record_version.valid_to_sequence > ?)
				ORDER BY session_record_version.source_sequence DESC
				LIMIT ?
			`)
			.all("session", 10, 10, 10, 51)
			.map(({ detail }) => detail)
			.join("\\n");
		const statisticsPlan = persistence.projection.sqlite
			.query<{ detail: string }, [string, number]>(`
				EXPLAIN QUERY PLAN
				SELECT COUNT(*) FROM session_record
				WHERE session_id = ? AND source_sequence <= ?
			`)
			.all("session", 10)
			.map(({ detail }) => detail)
			.join("\\n");
		const turnStatisticsPlan = persistence.projection.sqlite
			.query<{ detail: string }, [string, string, number]>(`
				EXPLAIN QUERY PLAN
				SELECT COUNT(*) FROM session_record
				WHERE session_id = ? AND turn_id = ? AND source_sequence <= ?
			`)
			.all("session", "turn", 10)
			.map(({ detail }) => detail)
			.join("\\n");

		expect(catalogPlan).toContain("idx_session_catalog_version_order");
		expect(historyPlan).toContain("idx_session_record_version_page");
		expect(statisticsPlan).toContain("idx_session_record_session_sequence");
		expect(turnStatisticsPlan).toContain(
			"idx_session_record_session_turn_sequence"
		);
		expect(catalogPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		expect(historyPlan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
		expect(statisticsPlan).not.toContain("SCAN session_record");
		expect(turnStatisticsPlan).not.toContain("SCAN session_record");
	} finally {
		persistence.close();
	}
});

test("catalog reads ignore abandoned directory-publication staging paths", async () => {
	const databasePath = path.join(root, "abandoned-directory-staging.sqlite");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	await fs.mkdir(logRoot, { recursive: true });
	const canonicalLogRoot = await fs.realpath(logRoot);
	await fs.mkdir(
		path.join(
			canonicalLogRoot,
			`${SESSION_DIRECTORY_STAGING_PREFIX}after-crash`
		)
	);

	try {
		await expect(persistence.store.listSessions()).resolves.toEqual([]);
		await expect(
			persistence.attachmentStore.collect({ liveAttachmentIds: [] })
		).resolves.toMatchObject({ orphanCount: 0, reclaimedCount: 0 });
	} finally {
		persistence.close();
	}
});

test("a fresh catalog read cannot claim an unbound log during another Workspace's Session creation", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-page-workspace-claim",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const workspaceA = path.join(root, "catalog-page-workspace-a");
	const workspaceB = path.join(root, "catalog-page-workspace-b");
	await fs.mkdir(workspaceA, { recursive: true });
	await fs.mkdir(workspaceB, { recursive: true });
	const sessionId = toSessionId("catalog-page-workspace-b-session");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	await fs.mkdir(logRoot, { recursive: true });
	const canonicalLogRoot = await fs.realpath(logRoot);
	const logPath = path.join(canonicalLogRoot, sessionId, "session.jsonl");
	const published = Promise.withResolvers<void>();
	const resumeCreation = Promise.withResolvers<void>();
	let pausedAtPublishedLog = false;
	const fileIo: SessionLogFileIo = {
		syncDirectory: async (directory, handle) => {
			if (process.platform !== "win32") {
				await handle.sync();
			}
			if (directory !== canonicalLogRoot || pausedAtPublishedLog) {
				return;
			}
			try {
				await fs.access(logPath);
			} catch {
				return;
			}
			pausedAtPublishedLog = true;
			published.resolve();
			await resumeCreation.promise;
		},
	};
	const reader = createSessionJsonlTestPersistence(databasePath, workspaceA);
	const writer = createSessionJsonlTestPersistence(
		databasePath,
		workspaceB,
		fileIo
	);
	const creationPromise = writer.store.createEmptySession({ id: sessionId });
	try {
		await published.promise;
		const catalogPagePromise = reader.store.listSessionsPage();
		await expect(reader.store.listSessions()).resolves.toEqual([]);
		await expect(
			reader.store.readSessionHistoryPage(sessionId)
		).rejects.toThrow("Session not found");

		resumeCreation.resolve();
		const creation = await creationPromise;
		expect(creation.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		await expect(catalogPagePromise).resolves.toMatchObject({ sessions: [] });
		await expect(writer.store.listSessionsPage()).resolves.toMatchObject({
			sessions: [{ id: sessionId }],
		});
		await expect(reader.store.listSessionsPage()).resolves.toMatchObject({
			sessions: [],
		});
	} finally {
		resumeCreation.resolve();
		await creationPromise;
		reader.close();
		writer.close();
	}
});

test("foreign Workspaces cannot claim an interrupted Session and owner catalog reads require retry", async () => {
	const databasePath = path.join(
		root,
		"session-create-workspace-interrupted",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const workspaceA = path.join(root, "session-create-owner-workspace");
	const workspaceB = path.join(root, "session-create-claim-workspace");
	await fs.mkdir(workspaceA, { recursive: true });
	await fs.mkdir(workspaceB, { recursive: true });
	const sessionId = toSessionId("session-create-workspace-interrupted");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	await fs.mkdir(logRoot, { recursive: true });
	const canonicalLogRoot = await fs.realpath(logRoot);
	const logPath = path.join(canonicalLogRoot, sessionId, "session.jsonl");
	let failPublishedDirectorySync = true;
	const fileIo: SessionLogFileIo = {
		syncDirectory: async (directory, handle) => {
			if (process.platform !== "win32") {
				await handle.sync();
			}
			if (directory !== canonicalLogRoot || !failPublishedDirectorySync) {
				return;
			}
			try {
				await fs.access(logPath);
			} catch {
				return;
			}
			failPublishedDirectorySync = false;
			throw new Error("injected failure after Session log publication");
		},
	};
	const creator = createSessionJsonlTestPersistence(
		databasePath,
		workspaceA,
		fileIo
	);
	let creatorClosed = false;
	try {
		const interrupted = await creator.store.createEmptySession({
			id: sessionId,
		});
		expect(interrupted.writeOutcome).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
		});
		expect(await Bun.file(logPath).exists()).toBe(true);
		creator.close();
		creatorClosed = true;

		const claimant = createSessionJsonlTestPersistence(
			databasePath,
			workspaceB
		);
		try {
			const claim = await claimant.store.createEmptySession({ id: sessionId });
			expect(claim.writeOutcome).toMatchObject({
				kind: "not-committed",
				error: { code: "session_operation_conflict" },
			});
			expect(
				claimant.operational.sqlite
					.query(
						"SELECT workspace_id FROM local_session_binding WHERE session_id = ?"
					)
					.all(sessionId)
			).toEqual([]);
			expect(await claimant.store.listSessionsPage()).toMatchObject({
				sessions: [],
			});
		} finally {
			claimant.close();
		}

		const ownerRetry = createSessionJsonlTestPersistence(
			databasePath,
			workspaceA
		);
		try {
			await expect(ownerRetry.store.listSessionsPage()).rejects.toMatchObject({
				code: "session_log_write_indeterminate",
			});
			const recovered = await ownerRetry.store.createEmptySession({
				id: sessionId,
			});
			expect(recovered.writeOutcome).toMatchObject({
				kind: "committed",
				projection: "ready",
			});
			expect(await ownerRetry.store.listSessionsPage()).toMatchObject({
				sessions: [{ id: sessionId }],
			});
		} finally {
			ownerRetry.close();
		}
	} finally {
		if (!creatorClosed) {
			creator.close();
		}
	}
});

test("a fresh history page stats an unchanged log instead of decoding full history", async () => {
	const databasePath = path.join(
		root,
		"session-history-page-clean-head",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	let syncCount = 0;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			sync: async (_filePath, handle) => {
				syncCount += 1;
				await handle.sync();
			},
		}
	);
	const sessionId = toSessionId("session-history-page-clean-head");
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		syncCount = 0;
		const page = await persistence.store.readSessionHistoryPage(sessionId);
		expect(page.records).toEqual([]);
		expect(syncCount).toBe(0);
	} finally {
		persistence.close();
	}
});

test("history-page catch-up rejects an appended record that reuses a retained Message identity", async () => {
	const databasePath = path.join(
		root,
		"session-history-page-duplicate-message-catchup",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionId = toSessionId("history-page-duplicate-message-catchup");
	const messageId = sessionMessageId("history-page-duplicate-message");
	const logPath = path.join(
		resolveLocalSessionLogRoot(databasePath),
		sessionId,
		"session.jsonl"
	);
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const firstRecord = buildUserSessionRecord({
			agentId: agentId("history-page-catchup-agent"),
			message: createSessionUserMessage(
				"First durable message.",
				undefined,
				[],
				[],
				messageId
			),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("history-page-first-turn"),
		});
		const firstOutcome = await persistence.store.commitSessionRecord({
			record: firstRecord,
			sessionId,
		});
		if (firstOutcome.kind !== "committed") {
			throw new Error("The history-page fixture record was not committed.");
		}
		const originalBytes = await Bun.file(logPath).bytes();
		const state = decodeSessionLog(sessionId, originalBytes);
		const duplicateRecord = buildUserSessionRecord({
			agentId: agentId("history-page-catchup-agent"),
			message: createSessionUserMessage(
				"This duplicate identity must not be projected.",
				undefined,
				[],
				[],
				messageId
			),
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("history-page-duplicate-turn"),
		});
		const duplicateEvent = createSessionLogEvent({
			operationId: "history-page-duplicate-message-event",
			payload: { record: duplicateRecord },
			previousHash: state.lastHash,
			sequence: state.nextSequence,
			sessionId,
			timestamp: new Date().toISOString(),
			type: "record.committed",
		});
		const cursorBefore = persistence.projection.sqlite
			.query(
				"SELECT generation, last_hash, log_id, next_byte_offset, next_sequence FROM session_projection_cursor WHERE session_id = ?"
			)
			.get(sessionId);
		await Bun.write(
			logPath,
			new Uint8Array([
				...originalBytes,
				...encodeSessionLogLine(duplicateEvent),
			])
		);

		await expect(
			persistence.store.readSessionHistoryPage(sessionId)
		).rejects.toMatchObject({
			code: "session_log_corrupt",
			offset: originalBytes.byteLength,
			sequence: state.nextSequence,
		});
		expect(
			persistence.projection.sqlite
				.query(
					"SELECT generation, last_hash, log_id, next_byte_offset, next_sequence FROM session_projection_cursor WHERE session_id = ?"
				)
				.get(sessionId)
		).toEqual(cursorBefore);
		expect(
			persistence.projection.sqlite
				.query(
					"SELECT COUNT(*) AS count FROM session_record_message_identity WHERE session_id = ?"
				)
				.get(sessionId)
		).toEqual({ count: 1 });
	} finally {
		persistence.close();
	}
});

test("a fresh catalog page stats unchanged logs instead of decoding full histories", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-page-clean-head",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	let syncCount = 0;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			sync: async (_filePath, handle) => {
				syncCount += 1;
				await handle.sync();
			},
		}
	);
	const sessionId = toSessionId("session-catalog-page-clean-head");
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		syncCount = 0;
		const page = await persistence.store.listSessionsPage();
		expect(page.sessions.map(({ id }) => id)).toContain(sessionId);
		expect(syncCount).toBe(0);
	} finally {
		persistence.close();
	}
});

test("a fresh Session catalog page catches up committed metadata when projection is blocked", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-page-projection-lag",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionId = toSessionId("session-catalog-page-projection-lag");
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_catalog_page_projection
			BEFORE UPDATE ON session
			BEGIN
				SELECT RAISE(ABORT, 'injected catalog page projection failure');
			END;
		`);
		const outcome = await persistence.store.updateSession(sessionId, {
			operationId: "catalog-page-projection-lag-update",
			title: "Committed title",
		});
		expect(outcome).toMatchObject({ kind: "committed", projection: "blocked" });
		await expect(
			persistence.store.listSessionsPage({ limit: 10 })
		).rejects.toMatchObject({ code: "session_projection_blocked" });

		persistence.projection.sqlite.exec(
			"DROP TRIGGER reject_catalog_page_projection"
		);
		const page = await persistence.store.listSessionsPage({ limit: 200 });
		expect(page.sessions.find(({ id }) => id === sessionId)).toMatchObject({
			id: sessionId,
			title: "Committed title",
		});
	} finally {
		persistence.projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_catalog_page_projection"
		);
		persistence.close();
	}
});

test("a fresh catalog page discovers a published Session after its projection recovers", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-page-created-projection-lag",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionId = toSessionId("session-catalog-page-created-projection-lag");
	try {
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_catalog_page_create
			BEFORE INSERT ON session
			BEGIN
				SELECT RAISE(ABORT, 'injected catalog create projection failure');
			END;
		`);
		const outcome = await persistence.store.createEmptySession({
			id: sessionId,
		});
		expect(outcome).toMatchObject({
			writeOutcome: { kind: "committed", projection: "blocked" },
		});
		await expect(
			persistence.store.listSessionsPage({ limit: 10 })
		).rejects.toMatchObject({ code: "session_projection_blocked" });

		persistence.projection.sqlite.exec(
			"DROP TRIGGER reject_catalog_page_create"
		);
		const page = await persistence.store.listSessionsPage({ limit: 10 });
		expect(page.sessions.find(({ id }) => id === sessionId)).toMatchObject({
			id: sessionId,
		});
	} finally {
		persistence.projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_catalog_page_create"
		);
		persistence.close();
	}
});

test("Session page methods reject malformed, out-of-range, and mismatched-scope requests", async () => {
	const databasePath = path.join(
		root,
		"session-page-errors",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionIds = {
		first: toSessionId("session-page-error-first"),
		second: toSessionId("session-page-error-second"),
	};
	const commitRecord = async (targetSessionId: SessionId, suffix: string) =>
		persistence.store.commitSessionRecord({
			record: buildUserSessionRecord({
				agentId: agentId("session-page-error-agent"),
				message: {
					id: sessionMessageId(`session-page-error-${suffix}`),
					parts: [{ text: suffix, type: "text" }],
					role: "user",
				},
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(`session-page-error-${suffix}`),
			}),
			sessionId: targetSessionId,
		});
	try {
		await persistence.store.createEmptySession({ id: sessionIds.first });
		await persistence.store.createEmptySession({ id: sessionIds.second });
		await commitRecord(sessionIds.first, "one");
		await commitRecord(sessionIds.first, "two");

		await expect(
			persistence.store.listSessionsPage({ cursor: "invalid cursor" })
		).rejects.toMatchObject({ code: "cursor_invalid" });
		await expect(
			persistence.store.readSessionHistoryPage(sessionIds.first, {
				cursor: "invalid cursor",
			})
		).rejects.toMatchObject({ code: "cursor_invalid" });
		await expect(
			persistence.store.listSessionsPage({ limit: 0 })
		).rejects.toMatchObject({ code: "page_limit_invalid" });
		await expect(
			persistence.store.readSessionHistoryPage(sessionIds.first, {
				limit: 201,
			})
		).rejects.toMatchObject({ code: "page_limit_invalid" });

		const historyFirstPage = await persistence.store.readSessionHistoryPage(
			sessionIds.first,
			{ limit: 1 }
		);
		const historyCursor = historyFirstPage.nextCursor;
		if (historyCursor === undefined) {
			throw new Error("The history page omitted its continuation cursor.");
		}
		await expect(
			persistence.store.readSessionHistoryPage(sessionIds.second, {
				cursor: historyCursor,
			})
		).rejects.toMatchObject({ code: "cursor_invalid" });

		const catalogFirstPage = await persistence.store.listSessionsPage({
			limit: 1,
		});
		const catalogCursor = catalogFirstPage.nextCursor;
		if (catalogCursor === undefined) {
			throw new Error("The catalog page omitted its continuation cursor.");
		}
		const decodedCursor = decodeSessionPageToken(catalogCursor, "catalog");
		if (decodedCursor.kind !== "catalog-page") {
			throw new Error("The catalog page returned a non-catalog cursor.");
		}
		const wrongWorkspaceCursor = encodeSessionPageToken({
			...decodedCursor,
			workspaceId: "another-workspace",
		});
		await expect(
			persistence.store.listSessionsPage({ cursor: wrongWorkspaceCursor })
		).rejects.toMatchObject({ code: "cursor_invalid" });
	} finally {
		persistence.close();
	}
});

test("Session catalog cursors expire after a Session is deleted", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-cursor-deletion",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	try {
		await persistence.store.createEmptySession({
			id: toSessionId("session-catalog-cursor-delete-a"),
		});
		await persistence.store.createEmptySession({
			id: toSessionId("session-catalog-cursor-delete-b"),
		});
		const firstPage = await persistence.store.listSessionsPage({ limit: 1 });
		const cursor = firstPage.nextCursor;
		if (cursor === undefined) {
			throw new Error("The catalog page omitted its continuation cursor.");
		}
		const firstSession = firstPage.sessions[0];
		if (firstSession === undefined) {
			throw new Error("The catalog page omitted its Session.");
		}
		await persistence.store.deleteSession(firstSession.id);
		await expect(
			persistence.store.listSessionsPage({ cursor })
		).rejects.toMatchObject({ code: "cursor_expired" });
	} finally {
		persistence.close();
	}
});

test("catalog cursors expire when workspace-scoped deletion state is introduced", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-cursor-deletion-state-migration",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const initial = createSessionJsonlTestPersistence(databasePath, workspace);
	let initialClosed = false;
	try {
		for (const id of [
			toSessionId("catalog-deletion-migration-first"),
			toSessionId("catalog-deletion-migration-second"),
		]) {
			const result = await initial.store.createEmptySession({ id });
			expect(result.writeOutcome.kind).toBe("committed");
		}
		const firstPage = await initial.store.listSessionsPage({ limit: 1 });
		const cursor = firstPage.nextCursor;
		if (cursor === undefined) {
			throw new Error("The catalog page omitted its continuation cursor.");
		}
		const oldProjectionId = (
			initial.projection.sqlite
				.query(
					"SELECT projection_id FROM session_projection_state WHERE id = 1"
				)
				.get() as { projection_id: string }
		).projection_id;
		initial.projection.sqlite
			.query(
				"UPDATE session_projection_state SET pagination_version = 1 WHERE id = 1"
			)
			.run();
		initial.close();
		initialClosed = true;

		const reopened = createSessionJsonlTestPersistence(databasePath, workspace);
		try {
			const migratedState = reopened.projection.sqlite
				.query(
					"SELECT pagination_version, projection_id FROM session_projection_state WHERE id = 1"
				)
				.get() as { pagination_version: number; projection_id: string };
			expect(migratedState.pagination_version).toBe(2);
			expect(migratedState.projection_id).not.toBe(oldProjectionId);
			await expect(
				reopened.store.listSessionsPage({ cursor })
			).rejects.toMatchObject({ code: "cursor_expired" });
			const refreshed = await reopened.store.listSessionsPage();
			expect(refreshed.sessions.map(({ id }) => id).sort()).toEqual([
				toSessionId("catalog-deletion-migration-first"),
				toSessionId("catalog-deletion-migration-second"),
			]);
		} finally {
			reopened.close();
		}
	} finally {
		if (!initialClosed) {
			initial.close();
		}
	}
});

test("catalog cursors expire when deletion projection falls back to row cleanup", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-cursor-deletion-fallback",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionIds = [
		toSessionId("catalog-cursor-fallback-delete"),
		toSessionId("catalog-cursor-fallback-keep"),
	];
	try {
		for (const id of sessionIds) {
			const created = await persistence.store.createEmptySession({ id });
			expect(created.writeOutcome.kind).toBe("committed");
		}
		const firstPage = await persistence.store.listSessionsPage({ limit: 1 });
		const cursor = firstPage.nextCursor;
		const deletedSession = firstPage.sessions[0];
		if (cursor === undefined || deletedSession === undefined) {
			throw new Error("The catalog page omitted its continuation state.");
		}
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_catalog_deletion_watermark
			BEFORE INSERT ON session_catalog_deletion_state
			BEGIN
				SELECT RAISE(ABORT, 'injected deletion watermark failure');
			END;
		`);

		const deletion = await persistence.store.deleteSession(deletedSession.id);
		expect(deletion).toMatchObject({ kind: "committed", projection: "ready" });
		await expect(
			persistence.store.listSessionsPage({ cursor })
		).rejects.toMatchObject({ code: "cursor_expired" });
		const refreshed = await persistence.store.listSessionsPage();
		expect(refreshed.sessions.map(({ id }) => id)).toEqual(
			sessionIds.filter((id) => id !== deletedSession.id)
		);
	} finally {
		persistence.projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_catalog_deletion_watermark"
		);
		persistence.close();
	}
});

test("deleting a Session in another Workspace preserves this catalog snapshot", async () => {
	const databasePath = path.join(
		root,
		"session-catalog-cursor-foreign-deletion",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const workspaceA = path.join(root, "catalog-cursor-owner-workspace");
	const workspaceB = path.join(root, "catalog-cursor-deletion-workspace");
	await fs.mkdir(workspaceA, { recursive: true });
	await fs.mkdir(workspaceB, { recursive: true });
	const firstSessionId = toSessionId("catalog-cursor-workspace-a-first");
	const secondSessionId = toSessionId("catalog-cursor-workspace-a-second");
	const foreignSessionId = toSessionId("catalog-cursor-workspace-b-only");
	const createdAt = new Date("2026-10-31T12:00:00.000Z");
	const owner = createSessionJsonlTestPersistence(databasePath, workspaceA);
	const foreign = createSessionJsonlTestPersistence(databasePath, workspaceB);
	try {
		for (const id of [firstSessionId, secondSessionId]) {
			const created = await owner.store.createEmptySession({ createdAt, id });
			expect(created.writeOutcome.kind).toBe("committed");
		}
		const foreignCreated = await foreign.store.createEmptySession({
			createdAt,
			id: foreignSessionId,
		});
		expect(foreignCreated.writeOutcome.kind).toBe("committed");
		const firstPage = await owner.store.listSessionsPage({ limit: 1 });
		const cursor = firstPage.nextCursor;
		expect(firstPage.sessions.map(({ id }) => id)).toEqual([firstSessionId]);
		if (cursor === undefined) {
			throw new Error("The catalog page omitted its continuation cursor.");
		}

		const deletion = await foreign.store.deleteSession(foreignSessionId);
		expect(deletion.kind).toBe("committed");
		await expect(
			owner.store.listSessionsPage({ cursor })
		).resolves.toMatchObject({
			sessions: [{ id: secondSessionId }],
		});
	} finally {
		owner.close();
		foreign.close();
	}
});

test("Session history cursors expire after projection generation changes", async () => {
	const databasePath = path.join(
		root,
		"session-history-cursor-rebuild",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionId = toSessionId("session-history-cursor-rebuild");
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		await persistence.store.createEmptySession({
			id: toSessionId("session-catalog-cursor-rebuild-other"),
		});
		for (const suffix of ["one", "two"]) {
			await persistence.store.commitSessionRecord({
				record: buildUserSessionRecord({
					agentId: agentId("session-history-cursor-agent"),
					message: {
						id: sessionMessageId(`session-history-cursor-${suffix}`),
						parts: [{ text: suffix, type: "text" }],
						role: "user",
					},
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					turnId: agentTurnId(`session-history-cursor-${suffix}`),
				}),
				sessionId,
			});
		}
		const firstPage = await persistence.store.readSessionHistoryPage(
			sessionId,
			{
				limit: 1,
			}
		);
		const cursor = firstPage.nextCursor;
		if (cursor === undefined) {
			throw new Error("The history page omitted its continuation cursor.");
		}
		const catalogFirstPage = await persistence.store.listSessionsPage({
			limit: 1,
		});
		const catalogCursor = catalogFirstPage.nextCursor;
		if (catalogCursor === undefined) {
			throw new Error("The catalog page omitted its continuation cursor.");
		}
		await persistence.store.rebuildProjection(
			{ kind: "session", sessionId },
			(operation) => operation()
		);
		await expect(
			persistence.store.readSessionHistoryPage(sessionId, { cursor })
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			persistence.store.listSessionsPage({ cursor: catalogCursor })
		).rejects.toMatchObject({ code: "cursor_expired" });
	} finally {
		persistence.close();
	}
});

test("Session history cursors expire after their Session is deleted", async () => {
	const databasePath = path.join(
		root,
		"session-history-cursor-deletion",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionId = toSessionId("session-history-cursor-delete");
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		for (const suffix of ["one", "two"]) {
			await persistence.store.commitSessionRecord({
				record: buildUserSessionRecord({
					agentId: agentId("session-history-cursor-delete-agent"),
					message: {
						id: sessionMessageId(`session-history-cursor-delete-${suffix}`),
						parts: [{ text: suffix, type: "text" }],
						role: "user",
					},
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					turnId: agentTurnId(`session-history-cursor-delete-${suffix}`),
				}),
				sessionId,
			});
		}
		const firstPage = await persistence.store.readSessionHistoryPage(
			sessionId,
			{
				limit: 1,
			}
		);
		const cursor = firstPage.nextCursor;
		if (cursor === undefined) {
			throw new Error("The history page omitted its continuation cursor.");
		}
		await persistence.store.deleteSession(sessionId);
		await expect(
			persistence.store.readSessionHistoryPage(sessionId, { cursor })
		).rejects.toMatchObject({ code: "cursor_expired" });
	} finally {
		persistence.close();
	}
});

test("recent Model selections block maintenance with no current workspace bindings", async () => {
	const databasePath = path.join(
		root,
		"recent-model-selection-unbound-maintenance",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("recent-model-selection-unbound-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		persistence.operational.sqlite
			.query("DELETE FROM local_session_binding WHERE session_id = ?")
			.run(sessionId);
		persistence.projection.sqlite.exec(
			"UPDATE session_projection_state SET status = 'rebuilding' WHERE id = 1"
		);

		await expect(
			persistence.store.listRecentModelSelections(10)
		).rejects.toMatchObject({ code: "session_projection_blocked" });
	} finally {
		persistence.close();
	}
});

test("recent Model selections catch up committed same-generation writes before reading", async () => {
	const databasePath = path.join(
		root,
		"recent-model-selection-lag",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("recent-model-selection-lag-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const record = buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: sessionMessageId("recent-model-selection-lag-user"),
				parts: [{ text: "restore the recent selection", type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("recent-model-selection-lag-turn"),
		});
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_recent_selection_projection
			BEFORE INSERT ON session_record
			BEGIN
				SELECT RAISE(ABORT, 'injected recent selection projection failure');
			END;
		`);
		const committed = await persistence.store.commitSessionRecord({
			record,
			sessionId,
		});
		expect(committed).toMatchObject({
			kind: "committed",
			projection: "blocked",
		});
		persistence.projection.sqlite.exec(
			"DROP TRIGGER reject_recent_selection_projection"
		);

		expect(await persistence.store.listRecentModelSelections(10)).toEqual([
			DEFAULT_PROVIDER_MODEL_SELECTION,
		]);
	} finally {
		persistence.projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_recent_selection_projection"
		);
		persistence.close();
	}
});

test("recent Model selections refresh stale projection generations before reading", async () => {
	const databasePath = path.join(
		root,
		"recent-model-selection-generation",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const rebuiltSessionId = toSessionId("a-recent-selection-rebuilt-session");
	const staleSessionId = toSessionId("z-recent-selection-stale-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: rebuiltSessionId });
		await persistence.store.createEmptySession({ id: staleSessionId });
		const record = buildUserSessionRecord({
			agentId: agentId("build"),
			message: {
				id: sessionMessageId("recent-model-selection-user"),
				parts: [{ text: "select a Model", type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: agentTurnId("recent-model-selection-turn"),
		});
		expect(
			await persistence.store.commitSessionRecord({
				record,
				sessionId: staleSessionId,
			})
		).toMatchObject({ kind: "committed", projection: "ready" });

		const rebuilt = await persistence.store.rebuildProjection(
			{ kind: "session", sessionId: rebuiltSessionId },
			async (action) => await action()
		);
		expect(rebuilt.issues).toEqual([]);
		await expect(
			persistence.store.listRecentModelSelections(10)
		).resolves.toEqual([DEFAULT_PROVIDER_MODEL_SELECTION]);
	} finally {
		persistence.close();
	}
});

test("an incomplete rebuild blocks reads until repaired logs are replayed", async () => {
	const databasePath = path.join(
		root,
		"incomplete-projection-rebuild",
		"sdk-incomplete-projection-rebuild.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("incomplete-rebuild-session");
	const healthySessionId = toSessionId("incomplete-rebuild-healthy-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		await persistence.store.createEmptySession({ id: healthySessionId });
		const logPath = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			sessionId,
			"session.jsonl"
		);
		const initialGeneration = (
			persistence.projection.sqlite
				.query("SELECT generation FROM session_projection_state WHERE id = 1")
				.get() as { generation: number }
		).generation;
		const validBytes = await Bun.file(logPath).bytes();
		const lines = new TextDecoder().decode(validBytes).trimEnd().split("\n");
		const created = JSON.parse(lines[1] ?? "{}") as { entryHash: string };
		created.entryHash =
			created.entryHash === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
		await Bun.write(logPath, `${lines[0]}\n${JSON.stringify(created)}\n`);

		const failedRebuild = await persistence.store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);
		const maintenanceState = persistence.projection.sqlite
			.query(
				"SELECT generation, status FROM session_projection_state WHERE id = 1"
			)
			.get() as { generation: number; status: string };
		await expect(persistence.store.getSession(sessionId)).rejects.toMatchObject(
			{
				code: "session_projection_blocked",
			}
		);
		expect(failedRebuild.issues).toMatchObject([
			{ code: "session_log_corrupt", sessionId },
		]);
		expect(maintenanceState).toMatchObject({
			generation: initialGeneration + 1,
			status: "rebuilding",
		});

		const partialRetry = await persistence.store.rebuildProjection(
			{ kind: "session", sessionId: healthySessionId },
			async (action) => await action()
		);
		expect(partialRetry.issues).toMatchObject([
			{ code: "session_log_corrupt", sessionId },
		]);
		expect(
			persistence.projection.sqlite
				.query("SELECT status FROM session_projection_state WHERE id = 1")
				.get()
		).toEqual({ status: "rebuilding" });

		await Bun.write(logPath, validBytes);
		const recovered = await persistence.store.rebuildProjection(
			{ kind: "session", sessionId: healthySessionId },
			async (action) => await action()
		);

		expect(recovered.generation).toBe(initialGeneration + 3);
		expect(recovered.issues).toEqual([]);
		expect(recovered.rebuiltSessionIds).toContain(sessionId);
		expect(recovered.rebuiltSessionIds).toContain(healthySessionId);
		expect((await persistence.store.getSession(sessionId)).id).toBe(sessionId);
		expect((await persistence.store.getSession(healthySessionId)).id).toBe(
			healthySessionId
		);
	} finally {
		persistence.close();
	}
});

test("a Session read refreshes its log snapshot when a writer advances the cursor", async () => {
	const databasePath = path.join(
		root,
		"projection-read-cursor-ahead",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-read-cursor-ahead-session");
	const syncStarted = Promise.withResolvers<void>();
	const releaseSync = Promise.withResolvers<void>();
	let interceptSync = false;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			if (
				interceptSync &&
				filePath.endsWith(path.join(sessionId, "session.jsonl"))
			) {
				interceptSync = false;
				syncStarted.resolve();
				await releaseSync.promise;
			}
			await handle.sync();
		},
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		fileIo
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const concurrentStore = createSessionJsonlStore(
		createDrizzleSessionStore(persistence.projection.db, {
			operationalDatabase: persistence.operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const pendingOperations: Promise<unknown>[] = [];

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		interceptSync = true;
		const pendingRead = persistence.store.getSession(sessionId);
		pendingOperations.push(pendingRead);
		await syncStarted.promise;

		const write = await concurrentStore.updateSession(sessionId, {
			operationId: "projection-read-advanced-cursor-write",
			title: "Written while the read was waiting.",
		});
		expect(write).toMatchObject({ kind: "committed", projection: "ready" });
		releaseSync.resolve();

		expect((await pendingRead).title).toBe(
			"Written while the read was waiting."
		);
	} finally {
		releaseSync.resolve();
		await Promise.allSettled(pendingOperations);
		persistence.close();
	}
});

test("fresh Session reads wait for the log durability barrier before projection catch-up", async () => {
	const databasePath = path.join(
		root,
		"projection-fresh-read-durability",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-fresh-read-durability-session");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const operational = createDatabase(databasePath);
	const secondOperational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const secondProjection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const syncStarted = Promise.withResolvers<void>();
	const releaseSync = Promise.withResolvers<void>();
	let interceptReadSync = false;
	const logPathSuffix = path.join(sessionId, "session.jsonl");
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			if (interceptReadSync && filePath.endsWith(logPathSuffix)) {
				syncStarted.resolve();
				await releaseSync.promise;
				interceptReadSync = false;
			}
			await handle.sync();
		},
	};
	const firstStore = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
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

	try {
		await firstStore.createEmptySession({ id: sessionId });
		await firstStore.updateSession(sessionId, {
			operationId: "durable-read-title",
			title: "Authoritative title",
		});
		projection.sqlite
			.query("UPDATE session SET title = ? WHERE id = ?")
			.run("Stale projection title", sessionId);
		projection.sqlite.exec("DELETE FROM session_projection_cursor");

		interceptReadSync = true;
		let settled = false;
		const pendingRead = secondStore.getSession(sessionId).then((session) => {
			settled = true;
			return session;
		});
		await syncStarted.promise;
		expect(settled).toBe(false);
		releaseSync.resolve();
		expect(await pendingRead).toMatchObject({ title: "Authoritative title" });
		expect(settled).toBe(true);
	} finally {
		releaseSync.resolve();
		operational.sqlite.close();
		secondOperational.sqlite.close();
		projection.sqlite.close();
		secondProjection.sqlite.close();
	}
});

test("an in-flight catch-up cannot publish projection rows during maintenance", async () => {
	const databasePath = path.join(
		root,
		"projection-maintenance-in-flight-read",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-maintenance-in-flight-session");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const readSyncStarted = Promise.withResolvers<void>();
	const releaseReadSync = Promise.withResolvers<void>();
	const rebuildSyncStarted = Promise.withResolvers<void>();
	const releaseRebuildSync = Promise.withResolvers<void>();
	let interceptReadSync = false;
	let interceptRebuildSync = false;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			if (filePath.endsWith(path.join(sessionId, "session.jsonl"))) {
				if (interceptReadSync) {
					interceptReadSync = false;
					readSyncStarted.resolve();
					await releaseReadSync.promise;
				}
				if (interceptRebuildSync) {
					interceptRebuildSync = false;
					rebuildSyncStarted.resolve();
					await releaseRebuildSync.promise;
				}
			}
			await handle.sync();
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
	const pendingOperations: Promise<unknown>[] = [];

	try {
		await store.createEmptySession({ id: sessionId });
		await store.updateSession(sessionId, {
			operationId: "maintenance-read-title",
			title: "Authoritative title",
		});
		projection.sqlite
			.query("UPDATE session SET title = ? WHERE id = ?")
			.run("Stale projection title", sessionId);
		projection.sqlite.exec("DELETE FROM session_projection_cursor");

		interceptReadSync = true;
		interceptRebuildSync = true;
		const pendingRead = store.getSession(sessionId);
		pendingOperations.push(pendingRead);
		await readSyncStarted.promise;
		const rebuilding = store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);
		pendingOperations.push(rebuilding);
		await rebuildSyncStarted.promise;
		expect(
			projection.sqlite
				.query("SELECT status FROM session_projection_state WHERE id = 1")
				.get()
		).toEqual({ status: "rebuilding" });
		await expect(store.listRecentModelSelections(10)).rejects.toMatchObject({
			code: "session_projection_blocked",
		});

		releaseReadSync.resolve();
		await expect(pendingRead).rejects.toMatchObject({
			code: "session_projection_blocked",
		});
		releaseRebuildSync.resolve();
		expect(await rebuilding).toMatchObject({
			issues: [],
			rebuiltSessionIds: [sessionId],
		});
		expect((await store.getSession(sessionId)).title).toBe(
			"Authoritative title"
		);
	} finally {
		releaseReadSync.resolve();
		releaseRebuildSync.resolve();
		await Promise.allSettled(pendingOperations);
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("in-process writes wait until a held-writer Session projection rebuild completes", async () => {
	const databasePath = path.join(
		root,
		"projection-rebuild-in-process-writer",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-rebuild-in-process-writer-session");
	const syncStarted = Promise.withResolvers<void>();
	const releaseSync = Promise.withResolvers<void>();
	let interceptSync = false;
	let maintenanceSyncReleased = false;
	let writeIntentDuringMaintenance = false;
	const logSyncEvents: string[] = [];
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			if (
				filePath.includes(path.join("indeterminate", `${sessionId}.json`)) &&
				!maintenanceSyncReleased
			) {
				writeIntentDuringMaintenance = true;
			}
			if (filePath.endsWith(path.join(sessionId, "session.jsonl"))) {
				if (interceptSync) {
					interceptSync = false;
					logSyncEvents.push("rebuild-sync-started");
					syncStarted.resolve();
					await releaseSync.promise;
					await handle.sync();
					logSyncEvents.push("rebuild-sync-complete");
					return;
				}
				logSyncEvents.push("other-log-sync-started");
			}
			await handle.sync();
		},
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		fileIo
	);
	const pendingOperations: Promise<unknown>[] = [];
	let writer: SessionWriterLock | undefined;

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		logSyncEvents.length = 0;
		writeIntentDuringMaintenance = false;
		writer = await persistence.store.acquireSessionWriter(sessionId);
		interceptSync = true;
		const rebuilding = persistence.store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);
		pendingOperations.push(rebuilding);
		await syncStarted.promise;

		const update = persistence.store.updateSession(sessionId, {
			operationId: "in-process-write-during-projection-rebuild",
			title: "Applied after the projection rebuild.",
		});
		pendingOperations.push(update);
		await Bun.sleep(50);
		expect(writeIntentDuringMaintenance).toBe(false);
		maintenanceSyncReleased = true;
		releaseSync.resolve();

		const rebuilt = await rebuilding;
		const writeOutcome = await update;
		expect(rebuilt.issues).toEqual([]);
		expect(writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		const rebuildSyncCompleted = logSyncEvents.indexOf("rebuild-sync-complete");
		expect(rebuildSyncCompleted).toBeGreaterThanOrEqual(0);
		expect(logSyncEvents.indexOf("other-log-sync-started")).toBeGreaterThan(
			rebuildSyncCompleted
		);
		expect((await persistence.store.getSession(sessionId)).title).toBe(
			"Applied after the projection rebuild."
		);
	} finally {
		releaseSync.resolve();
		await Promise.allSettled(pendingOperations);
		await writer?.release();
		persistence.close();
	}
});

test("projection rebuild holds Session Writer authority against concurrent appends", async () => {
	const databasePath = path.join(
		root,
		"projection-rebuild-writer-lock",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-rebuild-writer-lock-session");
	const syncStarted = Promise.withResolvers<void>();
	const releaseSync = Promise.withResolvers<void>();
	let interceptSync = false;
	const fileIo: SessionLogFileIo = {
		sync: async (filePath, handle) => {
			if (
				interceptSync &&
				filePath.endsWith(path.join(sessionId, "session.jsonl"))
			) {
				syncStarted.resolve();
				await releaseSync.promise;
				interceptSync = false;
			}
			await handle.sync();
		},
	};
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		fileIo
	);
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const secondStore = createSessionJsonlStore(
		createDrizzleSessionStore(persistence.projection.db, {
			operationalDatabase: persistence.operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const pendingOperations: Promise<unknown>[] = [];

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		interceptSync = true;
		const rebuilding = persistence.store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);
		pendingOperations.push(rebuilding);
		await syncStarted.promise;

		const concurrentWrite = await secondStore.updateSession(sessionId, {
			operationId: "projection-rebuild-concurrent-write",
			title: "Must not append during projection maintenance.",
		});
		expect(concurrentWrite).toMatchObject({
			kind: "not-committed",
			error: { code: "session_in_use" },
		});

		releaseSync.resolve();
		const rebuilt = await rebuilding;
		expect(rebuilt.issues).toEqual([]);
		expect((await persistence.store.getSession(sessionId)).title).toBe(
			"Untitled Session"
		);
	} finally {
		releaseSync.resolve();
		await Promise.allSettled(pendingOperations);
		persistence.close();
	}
});

test("projection rebuild reconciles deletion markers before rediscovery", async () => {
	const databasePath = path.join(
		root,
		"projection-rebuild-deletion",
		"sdk-projection-rebuild-deletion.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-rebuild-deleted-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const logRoot = await fs.realpath(resolveLocalSessionLogRoot(databasePath));
		const logBytes = await Bun.file(
			path.join(logRoot, sessionId, "session.jsonl")
		).bytes();
		const deleted = await persistence.store.deleteSession(sessionId);
		expect(deleted).toMatchObject({ kind: "committed", projection: "ready" });

		const orphanedDirectory = path.join(logRoot, sessionId);
		await fs.mkdir(orphanedDirectory, { recursive: true });
		await Bun.write(path.join(orphanedDirectory, "session.jsonl"), logBytes);
		const rebuilt = await persistence.store.rebuildProjection(
			{ kind: "session", sessionId },
			async (action) => await action()
		);

		expect(rebuilt).toMatchObject({
			issues: [],
			rebuiltSessionIds: [],
			skippedSessionIds: [sessionId],
		});
		await expect(fs.access(orphanedDirectory)).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(persistence.store.getSession(sessionId)).rejects.toThrow(
			"Session not found"
		);
	} finally {
		persistence.close();
	}
});

test("projection rebuild failure rolls back replacement rows and cursor", async () => {
	const databasePath = path.join(
		root,
		"projection-rebuild-rollback",
		"sdk-projection-rebuild-rollback.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const sessionId = toSessionId("projection-rebuild-rollback-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const coveredMessageId = sessionMessageId("rollback-covered-message");
		const keptMessageId = sessionMessageId("rollback-kept-message");
		for (const [messageId, text, turn] of [
			[coveredMessageId, "covered rollback history", "rollback-covered-turn"],
			[keptMessageId, "kept rollback history", "rollback-kept-turn"],
		] as const) {
			const record = buildUserSessionRecord({
				agentId: agentId("projection-rebuild-rollback-agent"),
				message: createSessionUserMessage(text, undefined, [], [], messageId),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(turn),
			});
			await persistence.store.commitSessionRecord({ record, sessionId });
		}
		const validCompaction = await persistence.store.appendCompaction({
			estimatedTokensAfter: 20,
			firstKeptUiMessageId: keptMessageId,
			id: compactionId("rollback-existing-compaction"),
			sessionId,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [coveredMessageId],
				formatVersion: 1,
				text: "Valid compaction before a failed rebuild.",
			},
			throughMessageUiId: coveredMessageId,
			tokensBefore: 80,
			trigger: "threshold",
		});
		if (validCompaction.writeOutcome.kind !== "committed") {
			throw new Error("The rollback test compaction did not commit.");
		}
		const logPath = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			sessionId,
			"session.jsonl"
		);
		const validBytes = await Bun.file(logPath).bytes();
		const state = decodeSessionLog(sessionId, validBytes);
		const previousCompaction = state.entries.find(
			({ envelope }) => envelope.type === "compaction.committed"
		);
		if (previousCompaction === undefined) {
			throw new Error("The rollback test compaction event is missing.");
		}
		const invalidEvent = createSessionLogEvent({
			operationId: "rollback-invalid-compaction",
			payload: {
				...previousCompaction.envelope.payload,
				firstKeptUiMessageId: "missing-rollback-message",
				id: compactionId("rollback-invalid-compaction"),
				priorCompactionId: compactionId("rollback-existing-compaction"),
				sequence: 2,
			},
			previousHash: state.lastHash,
			sequence: state.nextSequence,
			sessionId,
			timestamp: new Date().toISOString(),
			type: "compaction.committed",
		});
		await Bun.write(
			logPath,
			new Uint8Array([...validBytes, ...encodeSessionLogLine(invalidEvent)])
		);

		const readProjectionState = () => ({
			compactions: persistence.projection.sqlite
				.query("SELECT COUNT(*) AS count FROM session_compaction")
				.get() as { count: number },
			cursor: persistence.projection.sqlite
				.query(
					"SELECT generation, last_hash, log_id, next_byte_offset, next_sequence FROM session_projection_cursor WHERE session_id = ?"
				)
				.get(sessionId),
			operations: persistence.projection.sqlite
				.query("SELECT COUNT(*) AS count FROM session_operation_lookup")
				.get() as { count: number },
			records: persistence.projection.sqlite
				.query("SELECT COUNT(*) AS count FROM session_record")
				.get() as { count: number },
			sessions: persistence.projection.sqlite
				.query("SELECT COUNT(*) AS count FROM session")
				.get() as { count: number },
			usage: persistence.projection.sqlite
				.query("SELECT COUNT(*) AS count FROM session_usage_entry")
				.get() as { count: number },
		});
		const before = readProjectionState();
		const result = await persistence.store.rebuildProjection(
			{ kind: "all" },
			async (action) => await action()
		);

		expect(result.issues.length).toBe(1);
		expect(result.rebuiltSessionIds).toEqual([]);
		expect(readProjectionState()).toEqual(before);
	} finally {
		persistence.close();
	}
});

test("legacy compaction retry preserves envelope and payload timestamps", async () => {
	const databasePath = path.join(root, "sdk-compaction-v1-retry.sqlite");
	const sessionId = toSessionId("compaction-v1-retry-session");
	const recoveredEnvelopeTimestamp = "2026-10-31T09:00:00.000Z";
	const payloadCreatedAt = new Date("2026-10-31T08:00:00.000Z");
	let logPath: string | undefined;
	let failCompactionAppend = false;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (failCompactionAppend && filePath === logPath) {
				failCompactionAppend = false;
				const event = JSON.parse(
					new TextDecoder().decode(bytes.subarray(offset, offset + length - 1))
				) as Record<string, unknown>;
				const { entryHash: _entryHash, ...unsignedEvent } = event;
				const changedEvent = {
					...unsignedEvent,
					timestamp: recoveredEnvelopeTimestamp,
				};
				const changedBytes = new TextEncoder().encode(
					encodeCanonicalSessionJson({
						...changedEvent,
						entryHash: new Bun.CryptoHasher("sha256")
							.update(encodeCanonicalSessionJson(changedEvent))
							.digest("hex"),
					})
				);
				await handle.write(
					changedBytes,
					0,
					changedBytes.byteLength,
					position + offset
				);
				const error = new Error("injected compaction ENOSPC");
				Reflect.set(error, "code", "ENOSPC");
				throw error;
			}
			return (await handle.write(bytes, offset, length, position + offset))
				.bytesWritten;
		},
	};
	let persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		fileIo
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		logPath = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			sessionId,
			"session.jsonl"
		);
		const coveredMessageId = sessionMessageId("compaction-v1-covered");
		const keptMessageId = sessionMessageId("compaction-v1-kept");
		for (const [messageId, text, turn] of [
			[coveredMessageId, "covered v1 history", "covered-v1-turn"],
			[keptMessageId, "kept v1 history", "kept-v1-turn"],
		] as const) {
			const record = buildUserSessionRecord({
				agentId: agentId("compaction-v1-agent"),
				message: createSessionUserMessage(text, undefined, [], [], messageId),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(turn),
			});
			await persistence.store.commitSessionRecord({ record, sessionId });
		}
		const input: AppendSessionCompactionInput = {
			createdAt: payloadCreatedAt,
			estimatedTokensAfter: 64,
			firstKeptUiMessageId: keptMessageId,
			id: compactionId("compaction-v1-retry"),
			sessionId,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [coveredMessageId],
				formatVersion: 1,
				text: "Recovered legacy compaction summary.",
			},
			throughMessageUiId: coveredMessageId,
			tokensBefore: 256,
			trigger: "threshold",
		};
		failCompactionAppend = true;
		const uncertain = await persistence.store.appendCompaction(input);
		expect(uncertain.writeOutcome).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
		});
		const intentPath = path.join(
			root,
			"session-control",
			"indeterminate",
			`${sessionId}.json`
		);
		const pendingIntent = (await Bun.file(intentPath).json()) as Record<
			string,
			unknown
		>;
		const originalTimestamp = pendingIntent.timestamp;
		if (typeof originalTimestamp !== "string") {
			throw new Error("The pending compaction intent omitted its timestamp.");
		}
		const {
			timestamp: _timestamp,
			version: _version,
			...legacyIntent
		} = pendingIntent;
		await Bun.write(
			intentPath,
			`${JSON.stringify({ ...legacyIntent, version: 1 })}\n`
		);
		persistence.close();
		persistence = createSessionJsonlTestPersistence(
			databasePath,
			workspace,
			fileIo
		);

		const recovered = await persistence.store.appendCompaction(input);
		expect(recovered.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(originalTimestamp).not.toBe(recoveredEnvelopeTimestamp);
		expect(recovered.compaction?.createdAt.toISOString()).toBe(
			originalTimestamp
		);
		const committedEvent = JSON.parse(
			(await Bun.file(logPath).text()).trim().split("\n").at(-1) ?? "{}"
		) as { payload: { createdAt: string }; timestamp: string };
		expect(committedEvent.timestamp).toBe(recoveredEnvelopeTimestamp);
		expect(committedEvent.payload.createdAt).toBe(originalTimestamp);
		expect(await persistence.store.getCompactions(sessionId)).toHaveLength(1);
	} finally {
		persistence.close();
	}
});

test("a legacy timestamp-less creation intent refuses a changed explicit time", async () => {
	const databasePath = path.join(
		root,
		"sdk-create-v1-timestamp-conflict.sqlite"
	);
	const sessionId = toSessionId("create-v1-timestamp-conflict-session");
	const templateSessionId = toSessionId("create-v1-timestamp-template");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const originalTimestamp = new Date("2026-10-31T10:00:00.000Z");
	const changedTimestamp = new Date("2026-10-31T11:00:00.000Z");

	try {
		const template = await persistence.store.createEmptySession({
			createdAt: originalTimestamp,
			id: templateSessionId,
		});
		expect(template.writeOutcome.kind).toBe("committed");
		const templateLog = await Bun.file(
			path.join(logRoot, templateSessionId, "session.jsonl")
		).text();
		const templateCreation = JSON.parse(templateLog.split("\n")[1] ?? "{}") as {
			payload: Record<string, unknown>;
		};
		const {
			createdAt: _createdAt,
			lastMessageAt: _lastMessageAt,
			...semanticPayload
		} = templateCreation.payload;
		const controlRoot = path.join(
			path.dirname(await fs.realpath(logRoot)),
			"session-control",
			"indeterminate"
		);
		const markerPath = path.join(controlRoot, `${sessionId}.json`);
		await fs.mkdir(controlRoot, { recursive: true });
		await Bun.write(
			markerPath,
			`${JSON.stringify({
				expectedOffset: 0,
				operationDigest: sessionLogOperationDigest(
					"session.created",
					semanticPayload
				),
				operationId: `create-${sessionId}`,
				sequence: 1,
				sessionId,
				type: "session.created",
				version: 1,
			})}\n`
		);

		const conflict = await persistence.store.createEmptySession({
			createdAt: changedTimestamp,
			id: sessionId,
		});
		expect(conflict.writeOutcome).toMatchObject({
			kind: "not-committed",
			error: { code: "session_operation_conflict" },
		});
		expect(
			await Bun.file(path.join(logRoot, sessionId, "session.jsonl")).exists()
		).toBe(false);
		expect(await Bun.file(markerPath).json()).toMatchObject({ version: 1 });
	} finally {
		persistence.close();
	}
});

test("a pending usage retry reuses its original default timestamp", async () => {
	const databasePath = path.join(root, "sdk-usage-timestamp-retry.sqlite");
	const sessionId = toSessionId("usage-timestamp-retry-session");
	let logPath: string | undefined;
	let failUsageWrite = true;
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (filePath === logPath && failUsageWrite) {
				failUsageWrite = false;
				throw new Error("injected failure before usage bytes");
			}
			return (await handle.write(bytes, offset, length, position)).bytesWritten;
		},
	};
	let persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		fileIo
	);
	const input = {
		costUsd: null,
		id: sessionUsageEntryId("defaulted-usage-timestamp"),
		kind: "cache-warm" as const,
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		sessionId,
		usage: { inputTokens: 25, outputTokens: 2 },
	};

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		logPath = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			sessionId,
			"session.jsonl"
		);
		const uncertain = await persistence.store.createSessionUsageEntry(input);
		expect(uncertain.writeOutcome).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
		});
		const intentPath = path.join(
			root,
			"session-control",
			"indeterminate",
			`${sessionId}.json`
		);
		const pendingIntent = (await Bun.file(intentPath).json()) as {
			timestamp: string;
		};

		persistence.close();
		persistence = createSessionJsonlTestPersistence(
			databasePath,
			workspace,
			fileIo
		);
		const recovered = await persistence.store.createSessionUsageEntry(input);
		expect(recovered.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
		expect(recovered.entry?.createdAt.toISOString()).toBe(
			pendingIntent.timestamp
		);
	} finally {
		persistence.close();
	}
});

test("short writes are retried so Session creation and append remain complete", async () => {
	const databasePath = path.join(root, "sdk-short-write.sqlite");
	const sessionId = toSessionId("short-write-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			write: async (_filePath, handle, bytes, offset, length, position) => {
				const chunkLength = Math.min(7, length);
				return (await handle.write(bytes, offset, chunkLength, position))
					.bytesWritten;
			},
		}
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const outcome = await persistence.store.updateSession(sessionId, {
			operationId: "short-write-update",
			title: "All bytes were written",
		});
		expect(outcome).toMatchObject({ kind: "committed" });
		expect((await persistence.store.getSession(sessionId)).title).toBe(
			"All bytes were written"
		);
		const logPath = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			sessionId,
			"session.jsonl"
		);
		expect((await Bun.file(logPath).text()).trimEnd().split("\n")).toHaveLength(
			3
		);
	} finally {
		persistence.close();
	}
});

test("ENOSPC and quarantine sync failure preserve the log for reopened same-operation retry", async () => {
	const databasePath = path.join(root, "sdk-partial-write.sqlite");
	let operational = createDatabase(databasePath);
	let projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const sessionId = toSessionId("partial-write-session");
	const logRoot = path.join(root, "partial-write-logs");
	const quarantineRootSuffix = path.join(
		"session-control",
		"quarantine",
		sessionId
	);
	let logPath: string | undefined;
	let failQuarantineDirectorySync = false;
	let quarantineDirectorySyncCount = 0;
	let injectedPartialWrite = false;
	const fileIo: SessionLogFileIo = {
		syncDirectory: async (directory, handle) => {
			if (process.platform !== "win32") {
				await handle.sync();
			}
			if (directory.endsWith(quarantineRootSuffix)) {
				quarantineDirectorySyncCount += 1;
				if (failQuarantineDirectorySync && quarantineDirectorySyncCount === 2) {
					throw new Error("injected quarantine directory sync failure");
				}
			}
		},
		write: async (filePath, handle, bytes, offset, length, position) => {
			if (filePath === logPath && !injectedPartialWrite) {
				injectedPartialWrite = true;
				const partialLength = Math.min(23, length);
				await handle.write(bytes, offset, partialLength, position + offset);
				const error = new Error("injected ENOSPC after partial write");
				Reflect.set(error, "code", "ENOSPC");
				throw error;
			}
			return (await handle.write(bytes, offset, length, position + offset))
				.bytesWritten;
		},
	};
	const createStore = () =>
		createSessionJsonlStore(
			createDrizzleSessionStore(projection.db, {
				operationalDatabase: operational.db,
				sessionLogRoot: logRoot,
				workspaceRoot: workspace,
			}),
			logRoot,
			fileIo
		);
	let store = createStore();
	const operationId = "x".repeat(512);

	try {
		await store.createEmptySession({ id: sessionId });
		logPath = path.join(await fs.realpath(logRoot), sessionId, "session.jsonl");
		const expectedOffset = (await fs.stat(logPath)).size;
		const prefixLines = (await Bun.file(logPath).text()).trimEnd().split("\n");
		const prefixEnvelope = JSON.parse(prefixLines.at(-1) ?? "{}") as {
			entryHash: string;
		};
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

		const incompleteLog = await Bun.file(logPath).bytes();
		failQuarantineDirectorySync = true;
		const blockedQuarantine = await store.updateSession(sessionId, {
			operationId,
			title: "Recovered after truncation",
		});
		expect(blockedQuarantine).toMatchObject({
			kind: "indeterminate",
			error: { code: "session_log_write_indeterminate" },
		});
		expect(await Bun.file(logPath).bytes()).toEqual(incompleteLog);
		const quarantinePath = path.join(
			root,
			"session-control",
			"quarantine",
			sessionId,
			`2-${operationIdFileStem(operationId)}.partial`
		);
		expect(await Bun.file(`${quarantinePath}.json`).exists()).toBe(true);
		failQuarantineDirectorySync = false;
		const intentPath = path.join(
			root,
			"session-control",
			"indeterminate",
			`${sessionId}.json`
		);
		const pendingMarker = (await Bun.file(intentPath).json()) as Record<
			string,
			unknown
		>;
		const {
			timestamp: _timestamp,
			version: _version,
			...legacyMarkerFields
		} = pendingMarker;
		await Bun.write(
			intentPath,
			`${JSON.stringify({ ...legacyMarkerFields, version: 1 })}\n`
		);

		operational.sqlite.close();
		projection.sqlite.close();
		operational = createDatabase(databasePath);
		projection = createDatabase(
			resolveLocalSessionProjectionPath(databasePath)
		);
		store = createStore();
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
		const quarantined = await Bun.file(quarantinePath).bytes();
		const quarantineMetadata: unknown = await Bun.file(
			`${quarantinePath}.json`
		).json();
		expect(quarantined.byteLength).toBeGreaterThan(0);
		expect(quarantined.at(-1)).not.toBe(0x0a);
		expect(quarantineMetadata).toMatchObject({
			byteLength: quarantined.byteLength,
			offset: expectedOffset,
			operationId,
			prefixHash: prefixEnvelope.entryHash,
			reason: "incomplete-final-line",
			sequence: 2,
			sessionId,
			suffixHash: new Bun.CryptoHasher("sha256")
				.update(quarantined)
				.digest("hex"),
			version: 1,
		});
		const entries = (await Bun.file(logPath).text())
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
		expect(await handle.continue()).toEqual({
			kind: "rejected",
			reason:
				"Session work is paused because its SQLite projection is unavailable. Close and reopen it after storage recovers.",
		});
		const laterAdmission = await handle.deliver({
			idempotencyKey: "blocked-later-delivery",
			text: "Do not queue behind blocked Session storage.",
		});
		expect(laterAdmission).toMatchObject({ rejected: true });
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
		const committedRecords = entries.filter(
			({ type }) => type === "record.committed"
		);
		expect(committedRecords).toHaveLength(1);
		const committedRecord = committedRecords[0];
		if (committedRecord === undefined) {
			throw new Error("The durable prompt record was not appended to JSONL.");
		}
		const receiptPath = path.join(
			path.dirname(logRoot),
			"session-control",
			"receipts",
			handle.sessionId,
			`${operationIdFileStem(committedRecord.operationId)}.json`
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

test("a valid JSONL prefix below the projection cursor blocks Session reopen with its byte boundary", async () => {
	const databasePath = path.join(
		root,
		"sdk-projection-prefix-corruption.sqlite"
	);
	const sessionId = toSessionId("projection-prefix-corruption-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);

	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const outcome = await persistence.store.updateSession(sessionId, {
			operationId: "prefix-cursor-update",
			title: "Projected beyond the surviving log",
		});
		expect(outcome).toMatchObject({ kind: "committed" });
		const logPath = path.join(
			await fs.realpath(resolveLocalSessionLogRoot(databasePath)),
			sessionId,
			"session.jsonl"
		);
		const committedBytes = await Bun.file(logPath).bytes();
		let newlineCount = 0;
		let prefixLength = 0;
		for (let index = 0; index < committedBytes.byteLength; index += 1) {
			if (committedBytes[index] === 0x0a) {
				newlineCount += 1;
				if (newlineCount === 2) {
					prefixLength = index + 1;
					break;
				}
			}
		}
		const validPrefix = committedBytes.subarray(0, prefixLength);
		await Bun.write(logPath, validPrefix);

		await expect(persistence.store.getSession(sessionId)).rejects.toMatchObject(
			{
				code: "session_log_corrupt",
				offset: committedBytes.byteLength,
				sequence: 2,
				sessionId,
			}
		);
		expect(await Bun.file(logPath).bytes()).toEqual(validPrefix);
	} finally {
		persistence.close();
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
		const coveredMessageId = sessionMessageId("jsonl-compaction-covered");
		const keptMessageId = sessionMessageId("jsonl-compaction-kept");
		for (const [messageId, text, turn] of [
			[coveredMessageId, "covered history", "covered-turn"],
			[keptMessageId, "kept history", "kept-turn"],
		] as const) {
			const record = buildUserSessionRecord({
				agentId: agentId("jsonl-compaction-agent"),
				message: createSessionUserMessage(text, undefined, [], [], messageId),
				model: DEFAULT_PROVIDER_MODEL_SELECTION,
				turnId: agentTurnId(turn),
			});
			const recordWrite = await services.store.commitSessionRecord({
				record,
				sessionId,
			});
			expect(recordWrite).toMatchObject({
				kind: "committed",
				projection: "ready",
			});
		}
		const input = {
			estimatedTokensAfter: 64,
			firstKeptUiMessageId: keptMessageId,
			id: compactionId("jsonl-compaction-retry"),
			sessionId,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [coveredMessageId],
				formatVersion: 1 as const,
				text: "Durably stored summary.",
			},
			throughMessageUiId: coveredMessageId,
			tokensBefore: 256,
			trigger: "threshold" as const,
			summarizationUsage: {
				inputTokens: 12,
				outputTokens: 3,
			},
		};
		const warmInput = {
			costUsd: 0.05,
			createdAt: new Date("2026-10-30T00:00:00.000Z"),
			id: sessionUsageEntryId("jsonl-cache-warm-usage"),
			kind: "cache-warm" as const,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId,
			usage: { inputTokens: 50, outputTokens: 1 },
		};
		const warm = await services.store.createSessionUsageEntry(warmInput);
		expect(warm).toMatchObject({
			entry: { id: warmInput.id, kind: "cache-warm", costUsd: 0.05 },
			writeOutcome: { kind: "committed", projection: "ready" },
		});
		const usageInput = {
			compactionId: input.id,
			costUsd: 0.25,
			createdAt: new Date("2026-10-31T00:00:00.000Z"),
			id: sessionUsageEntryId("jsonl-compaction-summary-usage"),
			kind: "compaction-summary" as const,
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId,
			usage: input.summarizationUsage,
		};
		const usage = await services.store.createSessionUsageEntry(usageInput);
		const usageRetry = await services.store.createSessionUsageEntry(usageInput);
		const usageConflict = await services.store.createSessionUsageEntry({
			...usageInput,
			usage: { inputTokens: 13, outputTokens: 3 },
		});
		expect(usage).toMatchObject({
			entry: { compactionId: input.id, costUsd: 0.25, id: usageInput.id },
			writeOutcome: { kind: "committed", projection: "ready" },
		});
		expect(usageRetry).toEqual(usage);
		expect(usageConflict.writeOutcome).toMatchObject({
			kind: "not-committed",
			error: { code: "session_operation_conflict" },
		});
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
			summarizationUsage: { inputTokens: 12, outputTokens: 3 },
		});
		expect(
			await reopenedServices.store.listSessionUsageEntries(sessionId)
		).toMatchObject([
			{
				costUsd: 0.05,
				id: sessionUsageEntryId("jsonl-cache-warm-usage"),
				kind: "cache-warm",
				usage: { inputTokens: 50, outputTokens: 1 },
			},
			{
				compactionId: compactionId("jsonl-compaction-retry"),
				costUsd: 0.25,
				id: sessionUsageEntryId("jsonl-compaction-summary-usage"),
				kind: "compaction-summary",
				usage: { inputTokens: 12, outputTokens: 3 },
			},
		]);
		const records = await reopenedServices.store.listSessionRecords(sessionId);
		expect(records.map(({ messages }) => messages[0]?.id)).toEqual([
			sessionMessageId("jsonl-compaction-covered"),
			sessionMessageId("jsonl-compaction-kept"),
		]);
		const activeMessages = rebuildActiveMessages(
			projectSessionRecords(records),
			await reopenedServices.store.getLatestCompaction(sessionId)
		);
		expect(activeMessages).toHaveLength(2);
		expect(
			activeMessages[0]?.parts.find(({ type }) => type === "text")
		).toMatchObject({
			text: expect.stringContaining("Durably stored summary."),
		});
		expect(activeMessages[1]?.id).toBe(
			sessionMessageId("jsonl-compaction-kept")
		);
		const log = await fs.readFile(
			path.join(root, "session-logs", sessionId, "session.jsonl"),
			"utf8"
		);
		expect(
			log
				.trimEnd()
				.split("\n")
				.map((line) => (JSON.parse(line) as { type: string }).type)
		).toEqual([
			"session.header",
			"session.created",
			"record.committed",
			"record.committed",
			"usage.committed",
			"usage.committed",
			"compaction.committed",
		]);
	} finally {
		await reopenedServices.shutdown();
	}
});

test("rejects JSONL compaction checkpoints that reference messages outside the transcript", async () => {
	const databasePath = path.join(
		root,
		"sdk-invalid-compaction-boundary.sqlite"
	);
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
	});
	try {
		const created = await services.store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		const result = await services.store.appendCompaction({
			estimatedTokensAfter: 64,
			firstKeptUiMessageId: sessionMessageId("missing-kept-message"),
			id: compactionId("invalid-compaction-boundary"),
			sessionId: created.id,
			summarizationModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			summary: {
				coveredMessageIds: [sessionMessageId("missing-covered-message")],
				formatVersion: 1,
				text: "This checkpoint must not be published.",
			},
			throughMessageUiId: sessionMessageId("missing-through-message"),
			tokensBefore: 256,
			trigger: "manual",
		});

		expect(result.writeOutcome).toMatchObject({
			error: { code: "invalid-boundary" },
			kind: "not-committed",
			retryDisposition: "do-not-retry",
		});
		expect(await services.store.getLatestCompaction(created.id)).toBeNull();
		const log = await fs.readFile(
			path.join(root, "session-logs", created.id, "session.jsonl"),
			"utf8"
		);
		expect(
			log
				.trimEnd()
				.split("\n")
				.map((line) => (JSON.parse(line) as { type: string }).type)
		).not.toContain("compaction.committed");
	} finally {
		await services.shutdown();
	}
});

test("a foreign unmarked deletion does not fail or delete Sessions in another Workspace", async () => {
	const testRoot = path.join(root, "foreign-delete-before-marker");
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const workspaceA = path.join(testRoot, "workspace-a");
	const workspaceB = path.join(testRoot, "workspace-b");
	await fs.mkdir(workspaceA, { recursive: true });
	await fs.mkdir(workspaceB, { recursive: true });
	const sessionA = toSessionId("foreign-delete-workspace-a");
	const sessionB = toSessionId("foreign-delete-workspace-b");
	const markerPath = path.join(
		testRoot,
		"session-control",
		"deleted",
		`${sessionB}.json`
	);
	let failMarkerSync = true;
	const workspaceAStore = createSessionJsonlTestPersistence(
		databasePath,
		workspaceA
	);
	const workspaceBStore = createSessionJsonlTestPersistence(
		databasePath,
		workspaceB,
		{
			sync: async (filePath, handle) => {
				if (
					failMarkerSync &&
					filePath.includes(path.join("deleted", `${sessionB}.json.`))
				) {
					failMarkerSync = false;
					throw new Error(
						"Injected failure before foreign deletion marker sync."
					);
				}
				await handle.sync();
			},
		}
	);
	try {
		await workspaceAStore.store.createEmptySession({ id: sessionA });
		await workspaceBStore.store.createEmptySession({ id: sessionB });

		expect(await workspaceBStore.store.deleteSession(sessionB)).toMatchObject({
			kind: "committed",
			projection: "blocked",
		});
		await fs.rm(markerPath, { force: true });
		expect(await Bun.file(markerPath).exists()).toBe(false);
		expect(
			await Bun.file(
				path.join(testRoot, "session-logs", sessionB, "session.jsonl")
			).text()
		).toContain('"type":"session.deleted"');

		await expect(
			workspaceAStore.store.listSessionsPage()
		).resolves.toMatchObject({
			sessions: [{ id: sessionA }],
		});
		await expect(
			workspaceAStore.store.readSessionHistoryPage(sessionA)
		).resolves.toMatchObject({ session: { id: sessionA } });
		await expect(
			workspaceAStore.store.listSessionCatalog()
		).resolves.toMatchObject({
			issues: [],
			sessions: [{ id: sessionA }],
		});

		expect(await Bun.file(markerPath).exists()).toBe(false);
		expect(
			await Bun.file(
				path.join(testRoot, "session-logs", sessionB, "session.jsonl")
			).exists()
		).toBe(true);
	} finally {
		workspaceAStore.close();
		workspaceBStore.close();
	}
});

test("public history pages hide another Workspace's durable deletion marker", async () => {
	const testRoot = path.join(root, "history-foreign-deleted-session");
	const databasePath = path.join(testRoot, "sessions.sqlite");
	const workspaceA = path.join(testRoot, "workspace-a");
	const workspaceB = path.join(testRoot, "workspace-b");
	await fs.mkdir(workspaceA, { recursive: true });
	await fs.mkdir(workspaceB, { recursive: true });
	const sessionB = toSessionId("history-foreign-deleted-session-b");
	const missingSession = toSessionId("history-foreign-missing-session");
	const markerPath = path.join(
		testRoot,
		"session-control",
		"deleted",
		`${sessionB}.json`
	);
	const logPath = path.join(
		testRoot,
		"session-logs",
		sessionB,
		"session.jsonl"
	);
	const workspaceBStore = createSessionJsonlTestPersistence(
		databasePath,
		workspaceB
	);
	try {
		await workspaceBStore.store.createEmptySession({ id: sessionB });
		expect(await workspaceBStore.store.deleteSession(sessionB)).toMatchObject({
			kind: "committed",
			projection: "ready",
		});
	} finally {
		workspaceBStore.close();
	}

	const markerBefore = await Bun.file(markerPath).bytes();
	expect(await Bun.file(logPath).exists()).toBe(false);
	const sdk = await createSessionSdk({
		cwd: workspaceA,
		databasePath,
		pluginPaths: [],
		workspace: workspaceA,
	});
	const readError = async (sessionId: SessionId) => {
		try {
			await sdk.readSessionHistoryPage(sessionId);
			return;
		} catch (error) {
			const code =
				error instanceof Error ? Reflect.get(error, "code") : undefined;
			return {
				...(typeof code === "string" ? { code } : {}),
				message: error instanceof Error ? error.message : String(error),
			};
		}
	};
	try {
		const foreignError = await readError(sessionB);
		const missingError = await readError(missingSession);

		expect(foreignError).toBeDefined();
		expect(missingError).toBeDefined();
		expect(foreignError).toEqual(missingError);
		expect(foreignError).not.toMatchObject({ code: "session_deleted" });
		expect(await Bun.file(markerPath).bytes()).toEqual(markerBefore);
		expect(await Bun.file(logPath).exists()).toBe(false);
	} finally {
		await sdk.dispose();
	}
});

test("recovery completes a synced deletion event before catalog discovery can return the Session", async () => {
	const databasePath = path.join(root, "sdk-delete-before-marker.sqlite");
	const sessionId = toSessionId("delete-before-marker-session");
	const markerPath = path.join(
		root,
		"session-control",
		"deleted",
		`${sessionId}.json`
	);
	const pendingIntentPath = path.join(
		root,
		"session-control",
		"indeterminate",
		`${sessionId}.json`
	);
	let failMarkerSync = true;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			sync: async (filePath, handle) => {
				if (
					failMarkerSync &&
					filePath.includes(path.join("deleted", `${sessionId}.json.`))
				) {
					failMarkerSync = false;
					throw new Error("Injected crash before deletion marker sync.");
				}
				await handle.sync();
			},
		}
	);
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const deletion = await persistence.store.deleteSession(sessionId);
		expect(deletion).toMatchObject({
			kind: "committed",
			projection: "blocked",
		});
		expect(await Bun.file(pendingIntentPath).exists()).toBe(true);
		expect(
			await Bun.file(
				path.join(root, "session-logs", sessionId, "session.jsonl")
			).text()
		).toContain('"type":"session.deleted"');
		await fs.rm(markerPath, { force: true });
		persistence.close();

		const reopenedPersistence = createSessionJsonlTestPersistence(
			databasePath,
			workspace
		);
		try {
			await expect(
				reopenedPersistence.store.getSession(sessionId)
			).rejects.toThrow("Session not found");
			expect(await Bun.file(markerPath).exists()).toBe(true);
			expect(await Bun.file(pendingIntentPath).exists()).toBe(false);
			const catalog = await reopenedPersistence.store.listSessionCatalog();
			expect(catalog.sessions.map(({ id }) => id)).not.toContain(sessionId);
			expect(catalog.issues).toEqual([]);
			expect(await Bun.file(markerPath).exists()).toBe(true);
			await expect(
				fs.access(path.join(root, "session-logs", sessionId))
			).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			reopenedPersistence.close();
		}
	} finally {
		persistence.close();
	}
});

test("a durable deletion marker reports cleanup pending and the same operation retries to completion", async () => {
	const databasePath = path.join(root, "sdk-delete-cleanup-pending.sqlite");
	const sessionId = toSessionId("delete-cleanup-pending-session");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const markerPath = path.join(
		root,
		"session-control",
		"deleted",
		`${sessionId}.json`
	);
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		persistence.projection.sqlite.exec(`
			CREATE TRIGGER fail_session_delete_cleanup
			BEFORE DELETE ON session
			BEGIN
				SELECT RAISE(ABORT, 'injected Session projection cleanup failure');
			END;
		`);

		const cleanupPending = await persistence.store.deleteSession(sessionId);
		expect(cleanupPending).toMatchObject({
			code: "session_cleanup_pending",
			kind: "cleanup-pending",
			operationId: `delete-${sessionId}`,
		});
		expect(await Bun.file(markerPath).exists()).toBe(true);
		expect(
			await Bun.file(path.join(root, "session-logs", sessionId)).exists()
		).toBe(false);

		persistence.projection.sqlite.exec(
			"DROP TRIGGER fail_session_delete_cleanup"
		);
		const retried = await persistence.store.deleteSession(sessionId);
		expect(retried).toMatchObject({
			kind: "committed",
			operationId: `delete-${sessionId}`,
			projection: "ready",
		});
		expect(await persistence.store.listSessions()).toEqual([]);
	} finally {
		persistence.close();
	}
});

test("deletion keeps its durable marker and reports cleanup pending when log removal fails", async () => {
	const databasePath = path.join(root, "sdk-delete-log-removal-pending.sqlite");
	const sessionId = toSessionId("delete-log-removal-pending-session");
	let failRemoval = true;
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace,
		{
			remove: async (filePath, options) => {
				if (failRemoval && filePath.endsWith(sessionId)) {
					failRemoval = false;
					throw new Error("Injected log removal failure.");
				}
				await fs.rm(filePath, options);
			},
		}
	);
	const markerPath = path.join(
		root,
		"session-control",
		"deleted",
		`${sessionId}.json`
	);
	const logDirectory = path.join(root, "session-logs", sessionId);
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const pending = await persistence.store.deleteSession(sessionId);
		expect(pending).toMatchObject({
			code: "session_cleanup_pending",
			kind: "cleanup-pending",
			operationId: `delete-${sessionId}`,
		});
		expect(await Bun.file(markerPath).exists()).toBe(true);
		expect(
			await fs.stat(logDirectory).then(
				() => true,
				() => false
			)
		).toBe(true);

		const retried = await persistence.store.deleteSession(sessionId);
		expect(retried).toMatchObject({
			kind: "committed",
			operationId: `delete-${sessionId}`,
			projection: "ready",
		});
		expect(
			await fs.stat(logDirectory).then(
				() => true,
				() => false
			)
		).toBe(false);
	} finally {
		persistence.close();
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

test("Session statistics share the history read point and report only persisted terminal usage", async () => {
	const databasePath = path.join(root, "session-statistics-read-point.sqlite");
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const sessionId = toSessionId("session-statistics-read-point");
	const completeTurnId = agentTurnId("session-statistics-complete-turn");
	const partialTurnId = agentTurnId("session-statistics-partial-turn");
	const usage = { inputTokens: 120, outputTokens: 25 };
	const assistantRecord = (
		id: string,
		turnId: AgentTurnId,
		outcome: SessionRecord["outcome"],
		messageUsage?: typeof usage
	): SessionRecord => ({
		agentId: agentId("statistics-agent"),
		id: sessionRecordId(id),
		messages: [
			{
				id: sessionMessageId(`${id}-message`),
				metadata: {
					model: DEFAULT_PROVIDER_MODEL_SELECTION,
					...(messageUsage === undefined ? {} : { usage: messageUsage }),
				},
				parts: [{ text: "Saved result", type: "text" }],
				role: "assistant",
			},
		],
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		outcome,
		turnId,
		version: SESSION_RECORD_VERSION,
	});
	const completedToolRecord: SessionRecord = {
		agentId: agentId("statistics-agent"),
		id: sessionRecordId("statistics-tool-record"),
		messages: [
			{
				id: sessionMessageId("statistics-tool-message"),
				metadata: { model: DEFAULT_PROVIDER_MODEL_SELECTION },
				parts: [
					{
						input: { path: "README.md" },
						outcome: { kind: "success", output: "read" },
						sequence: 0,
						toolCallId: toolCallId("statistics-tool-call"),
						toolName: "read",
						type: "tool-call",
					},
				],
				role: "assistant",
			},
		],
		model: DEFAULT_PROVIDER_MODEL_SELECTION,
		outcome: { kind: "tool" },
		turnId: completeTurnId,
		version: SESSION_RECORD_VERSION,
	};
	try {
		await persistence.store.createEmptySession({ id: sessionId });
		const userRecord = buildUserSessionRecord({
			agentId: agentId("statistics-agent"),
			message: {
				id: sessionMessageId("statistics-user-message"),
				parts: [{ text: "Count only saved records.", type: "text" }],
				role: "user",
			},
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			turnId: completeTurnId,
		});
		const partialRecord = assistantRecord(
			"statistics-partial-record",
			partialTurnId,
			{ kind: "checkpoint" }
		);
		const completedRecord = assistantRecord(
			"statistics-completed-record",
			completeTurnId,
			{
				kind: "assistant",
				terminal: { finishedAt: 1234, kind: "completed", usage },
			},
			usage
		);
		for (const record of [
			userRecord,
			completedToolRecord,
			partialRecord,
			completedRecord,
		]) {
			expect(
				await persistence.store.commitSessionRecord({ record, sessionId })
			).toMatchObject({ kind: "committed", projection: "ready" });
		}

		const history = await persistence.store.readSessionHistoryPage(sessionId);
		expect(history.readPoint).toBeString();
		const lateToolRecord: SessionRecord = {
			agentId: agentId("statistics-agent"),
			id: sessionRecordId("statistics-later-tool-record"),
			messages: [
				{
					id: sessionMessageId("statistics-later-tool-message"),
					metadata: { model: DEFAULT_PROVIDER_MODEL_SELECTION },
					parts: [
						{
							input: { path: "AGENTS.md" },
							outcome: { kind: "success", output: "read" },
							sequence: 0,
							toolCallId: toolCallId("statistics-later-tool-call"),
							toolName: "read",
							type: "tool-call",
						},
					],
					role: "assistant",
				},
			],
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			outcome: { kind: "tool" },
			turnId: agentTurnId("statistics-later-turn"),
			version: SESSION_RECORD_VERSION,
		};
		expect(
			await persistence.store.commitSessionRecord({
				record: lateToolRecord,
				sessionId,
			})
		).toMatchObject({ kind: "committed", projection: "ready" });
		const otherSessionId = toSessionId("session-statistics-other-session");
		await persistence.store.createEmptySession({ id: otherSessionId });
		await expect(
			persistence.store.getSessionStatistics(otherSessionId, {
				readPoint: history.readPoint,
			})
		).rejects.toMatchObject({ code: "cursor_invalid" });
		await expect(
			persistence.store.getSessionStatistics(sessionId, {
				readPoint: "not-a-history-read-point",
			})
		).rejects.toMatchObject({ code: "cursor_invalid" });
		const delayedUsage = await persistence.store.createSessionUsageEntry({
			costUsd: 0.25,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			id: sessionUsageEntryId("statistics-cache-warm-late"),
			kind: "cache-warm",
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId,
			usage: { inputTokens: 40, outputTokens: 0 },
		});
		expect(delayedUsage.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "ready",
		});

		const historical = await persistence.store.getSessionStatistics(sessionId, {
			readPoint: history.readPoint,
		});
		expect(historical).toMatchObject({
			completedToolCallCount: 1,
			recordCount: 4,
			readPoint: history.readPoint,
			terminalOutcomeCounts: { completed: 1 },
			usage: {
				actual: {
					contributionCount: 1,
					costs: [],
					inputTokens: 120,
					outputTokens: 25,
					unknownCostCount: 1,
				},
				auxiliary: { contributionCount: 0, inputTokens: null },
				inherited: { contributionCount: 0, inputTokens: null },
			},
		});
		const turn = await persistence.store.getSessionStatistics(sessionId, {
			turnId: partialTurnId,
		});
		expect(turn).toMatchObject({
			recordCount: 1,
			turn: {
				turnId: partialTurnId,
				terminalOutcome: { kind: "no-terminal-record" },
			},
			usage: { actual: { contributionCount: 0, inputTokens: null } },
		});
		const completedTurn = await persistence.store.getSessionStatistics(
			sessionId,
			{ turnId: completeTurnId }
		);
		expect(completedTurn).toMatchObject({
			completedToolCallCount: 1,
			recordCount: 3,
			terminalOutcomeCounts: { completed: 1 },
			turn: {
				completedToolCallCount: 1,
				recordCount: 3,
				terminalOutcome: { finishedAt: 1234, kind: "completed" },
				turnId: completeTurnId,
			},
			usage: {
				actual: {
					contributionCount: 1,
					inputTokens: 120,
					outputTokens: 25,
				},
			},
		});

		const current = await persistence.store.getSessionStatistics(sessionId);
		expect(current).toMatchObject({
			completedToolCallCount: 2,
			recordCount: 5,
			usage: {
				actual: { inputTokens: 120, outputTokens: 25, costs: [] },
				auxiliary: {
					contributionCount: 1,
					costs: [{ amount: 0.25, unit: "USD" }],
					inputTokens: 40,
				},
			},
		});

		persistence.projection.sqlite.exec(`
			CREATE TRIGGER reject_statistics_usage_projection
			BEFORE INSERT ON session_usage_entry
			BEGIN
				SELECT RAISE(ABORT, 'injected statistics usage projection failure');
			END;
		`);
		const blockedUsage = await persistence.store.createSessionUsageEntry({
			costUsd: 0.5,
			createdAt: new Date("2026-01-02T00:00:00.000Z"),
			id: sessionUsageEntryId("statistics-cache-warm-catchup"),
			kind: "cache-warm",
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionId,
			usage: { inputTokens: 1, outputTokens: 0 },
		});
		expect(blockedUsage.writeOutcome).toMatchObject({
			kind: "committed",
			projection: "blocked",
		});
		persistence.projection.sqlite.exec(
			"DROP TRIGGER reject_statistics_usage_projection"
		);
		await expect(
			persistence.store.getSessionStatistics(sessionId)
		).resolves.toMatchObject({
			usage: {
				auxiliary: {
					contributionCount: 2,
					costs: [{ amount: 0.75, unit: "USD" }],
					inputTokens: 41,
				},
			},
		});

		const rebuilt = await persistence.store.rebuildProjection(
			{ kind: "session", sessionId },
			(operation) => operation()
		);
		expect(rebuilt.issues).toEqual([]);
		await expect(
			persistence.store.getSessionStatistics(sessionId, {
				readPoint: history.readPoint,
			})
		).rejects.toMatchObject({ code: "cursor_expired" });
		await expect(
			persistence.store.getSessionStatistics(sessionId)
		).resolves.toMatchObject({
			completedToolCallCount: 2,
			recordCount: 5,
			usage: {
				actual: { inputTokens: 120 },
				auxiliary: { contributionCount: 2, inputTokens: 41 },
			},
		});
	} finally {
		persistence.close();
	}
});

test("a Session-only rebuild keeps statistics blocked until the outdated projection is fully rebuilt", async () => {
	const databasePath = path.join(
		root,
		"session-statistics-full-rebuild-gate",
		"sessions.sqlite"
	);
	await fs.mkdir(path.dirname(databasePath), { recursive: true });
	const persistence = createSessionJsonlTestPersistence(
		databasePath,
		workspace
	);
	const firstSessionId = toSessionId("statistics-rebuild-first-session");
	const secondSessionId = toSessionId("statistics-rebuild-second-session");
	try {
		await persistence.store.createEmptySession({ id: firstSessionId });
		await persistence.store.createEmptySession({ id: secondSessionId });
		persistence.projection.sqlite.exec(
			"UPDATE session_projection_state SET statistics_version = 0 WHERE id = 1"
		);
		await expect(
			persistence.store.getSessionStatistics(firstSessionId)
		).rejects.toMatchObject({ code: "session_projection_blocked" });

		const sessionRebuild = await persistence.store.rebuildProjection(
			{ kind: "session", sessionId: firstSessionId },
			(operation) => operation()
		);
		expect(sessionRebuild.issues).toEqual([]);
		for (const sessionId of [firstSessionId, secondSessionId]) {
			await expect(
				persistence.store.getSessionStatistics(sessionId)
			).rejects.toMatchObject({ code: "session_projection_blocked" });
		}

		const fullRebuild = await persistence.store.rebuildProjection(
			{ kind: "all" },
			(operation) => operation()
		);
		expect(fullRebuild.issues).toEqual([]);
		await expect(
			persistence.store.getSessionStatistics(firstSessionId)
		).resolves.toMatchObject({ recordCount: 0 });
		await expect(
			persistence.store.getSessionStatistics(secondSessionId)
		).resolves.toMatchObject({ recordCount: 0 });
	} finally {
		persistence.close();
	}
});

test("reopening rebuilds a missing SQLite projection from the committed Session log", async () => {
	const databasePath = path.join(root, "sdk-rebuild-projection.sqlite");
	const firstRecorder = createFakeProviderRecorder();
	const firstSdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => createFakeProviderCollection(firstRecorder),
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

	const secondRecorder = createFakeProviderRecorder();
	const secondSdk = await createSessionSdkWithRuntime({
		createProviderCollection: () =>
			createFakeProviderCollection(secondRecorder),
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

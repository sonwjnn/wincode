import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type { SessionHost } from "@/modules/sessions/host/types";
import { createDatabase } from "@/modules/sessions/storage/client";
import { createDrizzleSessionStore } from "@/modules/sessions/storage/drizzle-session-store";
import {
	resolveLocalSessionLogRoot,
	resolveLocalSessionProjectionPath,
	resolveSessionLogFilePath,
} from "@/modules/sessions/storage/path";
import {
	createSessionJsonlStore,
	type SessionLogFileIo,
} from "@/modules/sessions/storage/session-jsonl-store";
import type { SessionSendInput } from "@/modules/sessions/submission-types";
import {
	createFakeProviderCollection,
	createFakeProviderRecorder,
} from "../support/e2e-fake-runtime";
import { agentId } from "../support/identifiers";

const root = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-session-steering-")
);
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });

afterAll(async () => {
	await fs.rm(root, { force: true, recursive: true });
});

test("committed steering leaves its queue reservation settled when the projection blocks", async () => {
	const databasePath = path.join(root, "committed-steering.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const recorder = createFakeProviderRecorder();
	const chatStarted = Promise.withResolvers<void>();
	const finishChat = Promise.withResolvers<void>();
	recorder.beforeChat = async () => {
		chatStarted.resolve();
		await finishChat.promise;
	};
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => store,
		},
	});
	let host: SessionHost | undefined;
	let unsubscribeSubmission: (() => void) | undefined;
	let unsubscribeTurn: (() => void) | undefined;
	try {
		const created = await store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The test Session was not durably created.");
		}
		const openedHost = await services.capabilities
			.getSessionHostManager()
			.openHost({
				autoContinue: false,
				capabilities: services.capabilities,
				sessionId: created.id,
				view: true,
			});
		host = openedHost;
		const events: string[] = [];
		unsubscribeSubmission = openedHost.agentSession.onSubmissionEvent(
			(event) => {
				if (event.kind === "recalled") {
					events.push(event.submissionId);
				}
			}
		);
		const inputFor = (text: string): SessionSendInput => ({
			agent: agentId("build"),
			composition: { files: [], text },
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			userText: text,
		});
		const first = await openedHost.agentSession.prompt(
			inputFor("active request")
		);
		expect(first).toMatchObject({ rejected: false, disposition: "started" });
		await chatStarted.promise;
		const queued = await openedHost.agentSession.prompt(
			inputFor("steering survives storage failure")
		);
		expect(queued).toMatchObject({ rejected: false, disposition: "queued" });
		if (queued.rejected) {
			throw new Error("The queued Steering Message was not admitted.");
		}

		projection.sqlite.exec(`
			CREATE TRIGGER reject_steering_record_projection
			BEFORE INSERT ON session_record
			BEGIN
				SELECT RAISE(ABORT, 'injected steering projection failure');
			END;
		`);
		const steered = await openedHost.agentSession.steer();
		expect(steered).toMatchObject({
			kind: "steered",
			messageId: queued.messageId,
			submissionId: queued.submissionId,
		});
		expect(openedHost.getSnapshot()).toMatchObject({
			projectionBlocked: true,
			queuedSubmissions: [],
			steeringMessages: [{ status: "pending" }],
		});
		const steeringMessageId = openedHost.getSnapshot().steeringMessages[0]?.id;
		expect(String(steeringMessageId)).toBe(`steering-${queued.messageId}`);
		expect(await openedHost.agentSession.recallWaitingMessages()).toEqual([]);
		expect(events).toEqual([]);
		projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_steering_record_projection"
		);
		const committed = (await store.listSessionRecords(created.id)).flatMap(
			(record) => record.messages
		);
		expect(
			committed.filter((message) => message.id === queued.messageId)
		).toHaveLength(1);
		expect(
			committed.find((message) => message.id === queued.messageId)?.metadata
		).toMatchObject({ submissionStatus: "pending" });
		const settled = Promise.withResolvers<void>();
		unsubscribeTurn = openedHost.agentSession.subscribe(() => {
			if (!openedHost.getSnapshot().turnActive) {
				settled.resolve();
			}
		});
		finishChat.resolve();
		await Promise.race([
			settled.promise,
			Bun.sleep(5000).then(() => {
				throw new Error("The initial Session turn did not settle.");
			}),
		]);
		expect(recorder.requests).toHaveLength(1);
	} finally {
		finishChat.resolve();
		unsubscribeSubmission?.();
		unsubscribeTurn?.();
		projection.sqlite.exec(
			"DROP TRIGGER IF EXISTS reject_steering_record_projection"
		);
		await host?.shutdown();
		await services.shutdown();
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("a durably committed prompt is accepted when projection failure blocks model work", async () => {
	const databasePath = path.join(root, "committed-prompt-blocked.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const recorder = createFakeProviderRecorder();
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => store,
		},
	});
	let host: SessionHost | undefined;
	try {
		const created = await store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The test Session was not durably created.");
		}
		host = await services.capabilities.getSessionHostManager().openHost({
			autoContinue: false,
			capabilities: services.capabilities,
			sessionId: created.id,
			view: true,
		});
		projection.sqlite.exec(`
			CREATE TRIGGER reject_prompt_projection
			BEFORE INSERT ON session_record
			BEGIN
				SELECT RAISE(ABORT, 'injected prompt projection failure');
			END;
		`);
		const text = "Keep the durable prompt accepted.";
		const outcome = await host.agentSession.send({
			agent: agentId("build"),
			composition: { files: [], text },
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			userText: text,
		});

		expect(outcome).toEqual({ rejected: false });
		expect(host.getSnapshot()).toMatchObject({
			projectionBlocked: true,
			error: { outcome: { kind: "committed", projection: "blocked" } },
		});
		expect(
			host
				.getSnapshot()
				.transcript.some((message) =>
					message.parts.some(
						(part) => part.type === "text" && part.text === text
					)
				)
		).toBe(true);
		expect(recorder.requests).toEqual([]);
	} finally {
		projection.sqlite.exec("DROP TRIGGER IF EXISTS reject_prompt_projection");
		await host?.shutdown();
		await services.shutdown();
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("an indeterminate steering write keeps its queue entry reserved until reconciliation", async () => {
	const databasePath = path.join(root, "indeterminate-steering.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const recorder = createFakeProviderRecorder();
	const chatStarted = Promise.withResolvers<void>();
	const finishChat = Promise.withResolvers<void>();
	recorder.beforeChat = async () => {
		chatStarted.resolve();
		await finishChat.promise;
	};
	let failNextLogWrite = false;
	const steeringWriteReached = Promise.withResolvers<void>();
	const releaseSteeringWrite = Promise.withResolvers<void>();
	const fileIo: SessionLogFileIo = {
		write: async (filePath, handle, bytes, offset, length, position) => {
			const { bytesWritten } = await handle.write(
				bytes,
				offset,
				length,
				position
			);
			if (failNextLogWrite && path.extname(filePath) === ".jsonl") {
				failNextLogWrite = false;
				steeringWriteReached.resolve();
				await releaseSteeringWrite.promise;
				throw new Error("injected log write outcome uncertainty");
			}
			return bytesWritten;
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
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => store,
		},
	});
	let host: SessionHost | undefined;
	try {
		const created = await store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The test Session was not durably created.");
		}
		const openedHost = await services.capabilities
			.getSessionHostManager()
			.openHost({
				autoContinue: false,
				capabilities: services.capabilities,
				sessionId: created.id,
				view: true,
			});
		host = openedHost;
		const inputFor = (text: string): SessionSendInput => ({
			agent: agentId("build"),
			composition: { files: [], text },
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			userText: text,
		});
		const first = await openedHost.agentSession.prompt(
			inputFor("active request")
		);
		expect(first).toMatchObject({ rejected: false, disposition: "started" });
		await chatStarted.promise;
		const queued = await openedHost.agentSession.prompt(
			inputFor("do not recall an unresolved steering write")
		);
		expect(queued).toMatchObject({ rejected: false, disposition: "queued" });
		if (queued.rejected) {
			throw new Error("The queued Steering Message was not admitted.");
		}

		failNextLogWrite = true;
		const steering = openedHost.agentSession.steer();
		await steeringWriteReached.promise;
		const recallDuringWrite = openedHost.agentSession.recallWaitingMessages();
		releaseSteeringWrite.resolve();
		const [admission, recalledDuringWrite] = await Promise.all([
			steering,
			recallDuringWrite,
		]);
		expect(admission).toMatchObject({ kind: "rejected" });
		expect(recalledDuringWrite).toEqual([]);
		expect(failNextLogWrite).toBe(false);
		expect(openedHost.getSnapshot()).toMatchObject({
			projectionBlocked: true,
			queuedSubmissions: [{ messageId: queued.messageId }],
			steeringMessages: [],
			error: {
				outcome: { kind: "indeterminate" },
			},
		});
		const recalledBeforeReconciliation =
			await openedHost.agentSession.recallWaitingMessages();
		expect(recalledBeforeReconciliation).toEqual([]);
		expect(openedHost.getSnapshot().queuedSubmissions).toHaveLength(1);

		const reconciled = await store.getSession(created.id);
		expect(reconciled).not.toBeNull();
		const records = await store.listSessionRecords(created.id);
		expect(
			records
				.flatMap((record) => record.messages)
				.filter((message) => message.id === queued.messageId)
		).toHaveLength(1);
		expect(await openedHost.agentSession.recallWaitingMessages()).toEqual([]);
		expect(openedHost.getSnapshot().queuedSubmissions).toHaveLength(1);
		const settled = Promise.withResolvers<void>();
		const unsubscribeTurn = openedHost.agentSession.subscribe(() => {
			if (!openedHost.getSnapshot().turnActive) {
				settled.resolve();
			}
		});
		finishChat.resolve();
		await Promise.race([
			settled.promise,
			Bun.sleep(5000).then(() => {
				throw new Error("The initial Session turn did not settle.");
			}),
		]);
		unsubscribeTurn();
		expect(recorder.requests).toHaveLength(1);
	} finally {
		releaseSteeringWrite.resolve();
		finishChat.resolve();
		await host?.shutdown();
		await services.shutdown();
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

test("an unsteered queued Submission is neither logged nor replayed after reopening", async () => {
	const databasePath = path.join(root, "unsteered-queue-restart.sqlite");
	const logRoot = resolveLocalSessionLogRoot(databasePath);
	const operational = createDatabase(databasePath);
	const projection = createDatabase(
		resolveLocalSessionProjectionPath(databasePath)
	);
	const recorder = createFakeProviderRecorder();
	const chatStarted = Promise.withResolvers<void>();
	const finishChat = Promise.withResolvers<void>();
	recorder.beforeChat = async () => {
		chatStarted.resolve();
		await finishChat.promise;
	};
	const store = createSessionJsonlStore(
		createDrizzleSessionStore(projection.db, {
			operationalDatabase: operational.db,
			sessionLogRoot: logRoot,
			workspaceRoot: workspace,
		}),
		logRoot
	);
	const services = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			createProviderCollection: () => createFakeProviderCollection(recorder),
			store: () => store,
		},
	});
	let host: SessionHost | undefined;
	try {
		const created = await store.createEmptySession({
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
		});
		if (created.writeOutcome.kind !== "committed") {
			throw new Error("The test Session was not durably created.");
		}
		const manager = services.capabilities.getSessionHostManager();
		const openedHost = await manager.openHost({
			autoContinue: false,
			capabilities: services.capabilities,
			sessionId: created.id,
			view: true,
		});
		host = openedHost;
		const inputFor = (text: string): SessionSendInput => ({
			agent: agentId("build"),
			composition: { files: [], text },
			model: DEFAULT_PROVIDER_MODEL_SELECTION,
			sessionModel: DEFAULT_PROVIDER_MODEL_SELECTION,
			userText: text,
		});
		const first = await openedHost.agentSession.prompt(
			inputFor("request that starts before the queue")
		);
		expect(first).toMatchObject({ rejected: false, disposition: "started" });
		await chatStarted.promise;
		const queued = await openedHost.agentSession.prompt(
			inputFor("this draft must stay process-local")
		);
		expect(queued).toMatchObject({ rejected: false, disposition: "queued" });
		if (queued.rejected) {
			throw new Error("The queued Submission was not admitted.");
		}
		const logBeforeRestart = await Bun.file(
			resolveSessionLogFilePath(logRoot, created.id)
		).text();
		expect(logBeforeRestart).not.toContain(queued.submissionId);
		expect(logBeforeRestart).not.toContain(
			"this draft must stay process-local"
		);

		const settled = Promise.withResolvers<void>();
		const unsubscribeTurn = openedHost.agentSession.subscribe(() => {
			if (!openedHost.getSnapshot().turnActive) {
				settled.resolve();
			}
		});
		finishChat.resolve();
		await Promise.race([
			settled.promise,
			Bun.sleep(5000).then(() => {
				throw new Error("The initial Session turn did not settle.");
			}),
		]);
		unsubscribeTurn();
		await openedHost.shutdown();
		host = undefined;

		const reopenedHost = await manager.openHost({
			autoContinue: false,
			capabilities: services.capabilities,
			sessionId: created.id,
			view: true,
		});
		host = reopenedHost;
		expect(reopenedHost.getSnapshot()).toMatchObject({
			queuedSubmissions: [],
			steeringMessages: [],
		});
		expect(
			reopenedHost
				.getSnapshot()
				.transcript.some((message) => message.id === queued.messageId)
		).toBe(false);
		expect(recorder.requests).toHaveLength(1);
	} finally {
		finishChat.resolve();
		await host?.shutdown();
		await services.shutdown();
		operational.sqlite.close();
		projection.sqlite.close();
	}
});

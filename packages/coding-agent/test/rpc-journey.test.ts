import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runRpc } from "../modules/application/rpc/runner";
import { SessionWriterLockFailureError } from "../modules/sessions/storage/session-writer-lock";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "./support/identifiers";

const workspace = await mkdtemp(join("/tmp", "wincode-rpc-journey-"));
const databasePath = join(workspace, "conversation.sqlite");
const fakeSupport = await import("./support/e2e-fake-runtime");
const recorder = fakeSupport.createFakeModelClientRecorder();
await mock.module("@wincode/ai/model-client", () =>
	fakeSupport.createFakeModelClientModule(recorder)
);
const { createSessionCapabilities } = await import(
	"../modules/sessions/host/session-capabilities"
);
const { createDatabase } = await import("../modules/sessions/storage/client");
const { createDrizzleSessionStore } = await import(
	"../modules/sessions/storage/drizzle-session-store"
);

afterAll(async () => {
	await rm(workspace, { force: true, recursive: true });
});

test("raw JSONL drives a real Session Host through persistence", async () => {
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const stdout = {
		frames: stdoutFrames,
		write: (text: string): undefined => {
			stdoutFrames.push(text);
		},
	};
	const stderr = {
		frames: stderrFrames,
		write: (text: string): undefined => {
			stderrFrames.push(text);
		},
	};
	const initialized = Promise.withResolvers<void>();
	const invalidSelectionRejected = Promise.withResolvers<void>();
	const transcriptReady = Promise.withResolvers<void>();
	const connections = {
		authorize: async () => ({ kind: "api-key" as const, apiKey: "test-key" }),
		connect: async () => undefined,
		listProviders: async () => [
			{
				connected: true as const,
				connectionMethod: "api-key" as const,
				displayName: "OpenAI",
				id: "openai" as const,
				methods: ["api-key", "browser"] as const,
			},
		],
	};
	const assembly = await createSessionCapabilities({
		connections,
		cwd: workspace,
		databasePath,
		workspace,
	});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const initialize = `${request("initialize", "initialize", {
		capabilities: {},
		clientInfo: { name: "journey-test" },
		cwd: workspace,
		protocolVersion: 1,
	})}\n`;
	const create = `${request("create", "session/create", {
		initialSubmission: { text: "hello from rpc" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			effort: "high",
		},
	})}\n`;
	const invalidCreate = `${request("invalid-create", "session/create", {
		initialSubmission: { text: "reject unsupported effort" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			effort: "minimal",
		},
	})}\n`;
	const legacyCreate = `${request("legacy-create", "session/create", {
		initialSubmission: { text: "reject legacy variant" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			variant: "high",
		},
	})}\n`;
	const conflictingCreate = `${request("conflicting-create", "session/create", {
		initialSubmission: { text: "reject conflicting choices" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			effort: "high",
			reasoningMode: "none",
		},
	})}\n`;
	const transcript = `${request("transcript", "session/getTranscript", {})}\n`;
	const shutdown = `${request("shutdown", "server/shutdown", {})}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(initialize);
		await initialized.promise;
		yield new TextEncoder().encode(
			`${invalidCreate}${legacyCreate}${conflictingCreate}${create.slice(0, 11)}`
		);
		await invalidSelectionRejected.promise;
		yield new TextEncoder().encode(create.slice(11));
		await transcriptReady.promise;
		yield new TextEncoder().encode(transcript + shutdown);
	})();
	stdout.write = (text: string): undefined => {
		stdoutFrames.push(text);
		const frame = JSON.parse(text) as {
			id?: string;
			method?: string;
			params?: {
				state?: {
					status?: string;
					transcript?: { messageCount?: number };
				};
			};
		};
		if (frame.id === "initialize") {
			initialized.resolve();
		}
		if (frame.id === "invalid-create") {
			invalidSelectionRejected.resolve();
		}
		if (
			frame.method === "session/stateChanged" &&
			frame.params?.state?.status === "idle" &&
			(frame.params.state.transcript?.messageCount ?? 0) >= 2
		) {
			transcriptReady.resolve();
		}
	};
	const exitCode = await runRpc({
		composeCapabilities: async () => assembly,
		input,
		stderr,
		stdout,
	});
	const frames = stdoutFrames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);
	const createIndex = frames.findIndex((frame) => frame.id === "create");
	const firstEventIndex = frames.findIndex(
		(frame) => frame.method === "session/event"
	);
	const invalidSelectionFrame = frames.find(
		(frame) => frame.id === "invalid-create"
	);
	expect(invalidSelectionFrame?.error).toMatchObject({
		data: { code: "selection_unavailable" },
	});
	const legacySelectionFrame = frames.find(
		(frame) => frame.id === "legacy-create"
	);
	expect(legacySelectionFrame?.error).toMatchObject({
		data: { code: "selection_unavailable" },
	});
	const conflictingSelectionFrame = frames.find(
		(frame) => frame.id === "conflicting-create"
	);
	expect(conflictingSelectionFrame?.error).toMatchObject({
		data: { code: "selection_unavailable" },
	});
	expect(exitCode).toBe(0);
	expect(stderrFrames).toEqual([]);
	expect(createIndex).toBeGreaterThanOrEqual(0);
	expect(firstEventIndex).toBeGreaterThan(createIndex);
	expect(frames.some((frame) => frame.id === "transcript")).toBe(true);
	expect(frames.some((frame) => frame.id === "shutdown")).toBe(true);
	expect(
		recorder.requests.filter((entry) => entry.kind === "chat")
	).toHaveLength(1);
	const createFrame = frames[createIndex];
	const createResult = createFrame?.result;
	const sessionId =
		typeof createResult === "object" &&
		createResult !== null &&
		"sessionId" in createResult &&
		typeof createResult.sessionId === "string"
			? createResult.sessionId
			: undefined;
	expect(sessionId).toBeString();
	if (sessionId === undefined) {
		throw new Error("The RPC journey did not return a Session ID.");
	}
	const secondAssembly = await createSessionCapabilities({
		connections,
		cwd: workspace,
		databasePath,
		workspace,
	});
	const secondStdoutFrames: string[] = [];
	const secondStderrFrames: string[] = [];
	const secondExitCode = await runRpc({
		composeCapabilities: async () => secondAssembly,
		input: [
			new TextEncoder().encode(
				`${request("reinitialize", "initialize", {
					capabilities: {},
					clientInfo: { name: "reopen-test" },
					cwd: workspace,
					protocolVersion: 1,
				})}\n`
			),
			new TextEncoder().encode(
				`${request("open", "session/open", { sessionId })}\n`
			),
			new TextEncoder().encode(
				`${request("reopen-transcript", "session/getTranscript", {})}\n`
			),
			new TextEncoder().encode(
				`${request("reopen-shutdown", "server/shutdown", {})}\n`
			),
		],
		stderr: {
			write: (text: string): undefined => {
				secondStderrFrames.push(text);
			},
		},
		stdout: {
			write: (text: string): undefined => {
				secondStdoutFrames.push(text);
			},
		},
	});
	const secondFrames = secondStdoutFrames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);
	const openFrame = secondFrames.find((frame) => frame.id === "open");
	const openResult = openFrame?.result;
	const openState =
		typeof openResult === "object" &&
		openResult !== null &&
		"state" in openResult &&
		typeof openResult.state === "object" &&
		openResult.state !== null
			? openResult.state
			: undefined;
	expect(secondExitCode).toBe(0);
	expect(secondStderrFrames).toEqual([]);
	expect(openState).toBeDefined();
	expect(openState).toMatchObject({ selection: { effort: "high" } });
	expect(secondFrames.some((frame) => frame.id === "reopen-transcript")).toBe(
		true
	);
	const reopenTranscriptFrame = secondFrames.find(
		(frame) => frame.id === "reopen-transcript"
	);
	const reopenTranscriptResult = reopenTranscriptFrame?.result;
	const reopenMessages =
		typeof reopenTranscriptResult === "object" &&
		reopenTranscriptResult !== null &&
		"messages" in reopenTranscriptResult &&
		Array.isArray(reopenTranscriptResult.messages)
			? reopenTranscriptResult.messages
			: undefined;
	expect(reopenMessages).toBeDefined();
	if (reopenMessages === undefined) {
		throw new Error("The reopened RPC journey did not return a transcript.");
	}
	expect(reopenMessages.length).toBeGreaterThanOrEqual(2);
	expect(reopenMessages).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				metadata: expect.objectContaining({ effort: "high" }),
			}),
		])
	);
	const reopened = createDatabase(databasePath);
	const store = createDrizzleSessionStore(reopened.db, {
		workspaceRoot: workspace,
	});
	const sessions = await store.listSessions();
	expect(sessions).toHaveLength(1);
	const session = sessions[0];
	if (session === undefined) {
		throw new Error("The RPC journey did not persist a Session.");
	}
	const records = await store.listSessionRecords(session.id);
	expect(records.some((record) => record.outcome.kind === "user")).toBe(true);
	expect(records.map((record) => record.outcome.kind)).toContain("assistant");
	expect(
		records.some(
			(record) =>
				record.outcome.kind === "user" && record.model.effort === "high"
		)
	).toBe(true);
	const assistantRecord = records.find(
		(record) => record.outcome.kind === "assistant"
	);
	expect(assistantRecord?.model.effort).toBe("high");
	expect(
		assistantRecord?.messages.some(
			(message) => message.metadata?.effort === "high"
		)
	).toBe(true);
	expect(session.effort).toBe("high");
});

test("RPC session/open keeps a held Session Writer as a refusal", async () => {
	const connections = {
		authorize: async () => ({ kind: "api-key" as const, apiKey: "test-key" }),
		connect: async () => undefined,
		listProviders: async () => [
			{
				connected: true as const,
				connectionMethod: "api-key" as const,
				displayName: "OpenAI",
				id: "openai" as const,
				methods: ["api-key", "browser"] as const,
			},
		],
	};
	const conflictDatabasePath = join(workspace, "writer-conflict.sqlite");
	const ownerDatabase = createDatabase(conflictDatabasePath);
	const ownerStore = createDrizzleSessionStore(ownerDatabase.db, {
		attachmentRoot: join(workspace, "writer-conflict-attachments"),
		snapshotRoot: join(workspace, "writer-conflict-snapshots"),
		workspaceRoot: workspace,
	});
	const { id: sessionId } = await ownerStore.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("writer-conflict-message"),
			parts: [{ text: "existing session", type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId("writer-conflict-turn"),
	});
	const rpcAssembly = await createSessionCapabilities({
		connections,
		cwd: workspace,
		databasePath: conflictDatabasePath,
		workspace,
	});
	const ownerWriter = await ownerStore.acquireSessionWriter(sessionId, {
		executionMode: "interactive",
	});
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const input = [
		new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "writer-conflict-test" },
				cwd: workspace,
				protocolVersion: 1,
			})}\n`
		),
		new TextEncoder().encode(
			`${request("open", "session/open", { sessionId })}\n`
		),
		new TextEncoder().encode(`${request("shutdown", "server/shutdown", {})}\n`),
	];

	try {
		const exitCode = await runRpc({
			composeCapabilities: async () => rpcAssembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const openFrame = frames.find((frame) => frame.id === "open");

		expect(exitCode).toBe(0);
		expect(stderrFrames).toEqual([]);
		expect(openFrame?.error).toMatchObject({
			data: { code: "session_in_use" },
		});
	} finally {
		await ownerWriter.release();
		await rpcAssembly.shutdown();
		ownerDatabase.sqlite.close();
	}
});

test("RPC session opening keeps lock refusals request-scoped", async () => {
	const connections = {
		authorize: async () => ({ kind: "api-key" as const, apiKey: "test-key" }),
		connect: async () => undefined,
		listProviders: async () => [
			{
				connected: true as const,
				connectionMethod: "api-key" as const,
				displayName: "OpenAI",
				id: "openai" as const,
				methods: ["api-key", "browser"] as const,
			},
		],
	};
	const failureDatabasePath = join(workspace, "writer-lock-failure.sqlite");
	const failureAssembly = await createSessionCapabilities({
		connections,
		cwd: workspace,
		databasePath: failureDatabasePath,
		workspace,
	});
	const { id: sessionId } = await failureAssembly.store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("lock-failure-message"),
			parts: [{ text: "existing session", type: "text" }],
			role: "user",
		},
		model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		turnId: agentTurnId("lock-failure-turn"),
	});
	const acquireSessionWriter = failureAssembly.store.acquireSessionWriter;
	failureAssembly.store.acquireSessionWriter = async () => {
		throw new SessionWriterLockFailureError(new Error("lock unavailable"));
	};
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const input = [
		new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "lock-failure-test" },
				cwd: workspace,
				protocolVersion: 1,
			})}\n`
		),
		new TextEncoder().encode(
			`${request("open", "session/open", { sessionId })}\n`
		),
		new TextEncoder().encode(
			`${request("create", "session/create", {
				initialSubmission: { text: "new RPC session" },
				selection: {
					agentId: "build",
					model: { modelId: "gpt-5.6-luna", providerId: "openai" },
				},
			})}\n`
		),
		new TextEncoder().encode(`${request("shutdown", "server/shutdown", {})}\n`),
	];

	try {
		const exitCode = await runRpc({
			composeCapabilities: async () => failureAssembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout: {
				write: (text: string): undefined => {
					stdoutFrames.push(text);
				},
			},
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		expect(exitCode).toBe(0);
		expect(stderrFrames).toEqual([]);
		expect(frames.find((frame) => frame.id === "open")?.error).toMatchObject({
			data: { code: "session_lock_failed" },
		});
		expect(frames.find((frame) => frame.id === "create")?.error).toMatchObject({
			data: { code: "session_lock_failed" },
		});
		expect(frames.some((frame) => frame.method === "server/fatal")).toBe(false);
	} finally {
		failureAssembly.store.acquireSessionWriter = acquireSessionWriter;
		await failureAssembly.shutdown();
	}
});

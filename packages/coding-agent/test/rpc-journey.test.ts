import { afterAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runRpc } from "../modules/application/rpc/runner";

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
		},
	})}\n`;
	const transcript = `${request("transcript", "session/getTranscript", {})}\n`;
	const shutdown = `${request("shutdown", "server/shutdown", {})}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(`${initialize}${create.slice(0, 11)}`);
		await initialized.promise;
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
	expect(exitCode).toBe(0);
	expect(stderrFrames).toEqual([]);
	expect(createIndex).toBeGreaterThanOrEqual(0);
	expect(firstEventIndex).toBeGreaterThan(createIndex);
	expect(frames.some((frame) => frame.id === "transcript")).toBe(true);
	expect(frames.some((frame) => frame.id === "shutdown")).toBe(true);
	expect(recorder.requests.some((entry) => entry.kind === "chat")).toBe(true);
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
	reopened.sqlite.close();
});

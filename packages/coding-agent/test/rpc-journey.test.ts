import { afterAll, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { buildAgentRegistry } from "../modules/agents/registry";
import { runRpc } from "../modules/application/rpc/runner";
import { SessionWriterLockFailureError } from "../modules/sessions/storage/session-writer-lock";
import type { ConfigSnapshot } from "../shared/config/config-store";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "./support/identifiers";

const workspace = await mkdtemp(join("/tmp", "wincode-rpc-journey-"));
const commandDirectory = join(workspace, ".wincode", "commands");
await mkdir(commandDirectory, { recursive: true });
await Bun.write(
	join(commandDirectory, "review.md"),
	"---\ndescription: Review API changes\n---\nInspect only $ARGUMENTS."
);
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
	const modelStepStarted = Promise.withResolvers<void>();
	const releaseModelStep = Promise.withResolvers<void>();
	const secondModelStepStarted = Promise.withResolvers<void>();
	const releaseSecondModelStep = Promise.withResolvers<void>();
	const queuedSubmitAccepted = Promise.withResolvers<void>();
	const steeringAccepted = Promise.withResolvers<void>();
	let modelStepCount = 0;
	let secondModelStepReleased = false;
	recorder.beforeStep = async () => {
		modelStepCount += 1;
		if (modelStepCount === 1) {
			modelStepStarted.resolve();
			await releaseModelStep.promise;
		} else if (modelStepCount === 2) {
			secondModelStepStarted.resolve();
			await releaseSecondModelStep.promise;
		}
	};
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
		protocolVersion: 4,
	})}\n`;
	const create = `${request("create", "session/create", {
		initialSubmission: {
			composition: {
				pastedText: [{ text: "API handlers", token: "[Pasted ~2 lines]" }],
				text: "[Pasted ~2 lines]",
			},
			intent: { kind: "custom", name: "review" },
		},
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
	const queuedSubmit = `${request("queued-submit", "session/submit", {
		submission: {
			intent: { kind: "custom", name: "review" },
			text: "resource boundaries",
		},
	})}\n`;
	const steerQueued = `${request("steer-queued", "session/steer", {})}\n`;
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
		await modelStepStarted.promise;
		yield new TextEncoder().encode(queuedSubmit);
		await queuedSubmitAccepted.promise;
		yield new TextEncoder().encode(steerQueued);
		await steeringAccepted.promise;
		releaseModelStep.resolve();
		await secondModelStepStarted.promise;
		secondModelStepReleased = true;
		releaseSecondModelStep.resolve();
		await transcriptReady.promise;
		yield new TextEncoder().encode(transcript + shutdown);
	})();
	stdout.write = (text: string): undefined => {
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
		stdoutFrames.push(text);
		if (frame.id === "initialize") {
			initialized.resolve();
		}
		if (frame.id === "invalid-create") {
			invalidSelectionRejected.resolve();
		}
		if (frame.id === "queued-submit") {
			queuedSubmitAccepted.resolve();
		}
		if (frame.id === "steer-queued") {
			steeringAccepted.resolve();
		}
		if (
			modelStepCount >= 2 &&
			secondModelStepReleased &&
			frame.method === "session/stateChanged" &&
			frame.params?.state?.status === "idle"
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
	const queuedSubmitFrame = frames.find(
		(frame) => frame.id === "queued-submit"
	);
	expect(queuedSubmitFrame?.result).toMatchObject({
		disposition: "queued",
		rejected: false,
	});
	const steerFrame = frames.find((frame) => frame.id === "steer-queued");
	expect(steerFrame?.result).toMatchObject({ kind: "steered" });
	expect(frames.some((frame) => frame.id === "transcript")).toBe(true);
	expect(frames.some((frame) => frame.id === "shutdown")).toBe(true);
	const chatRequests = recorder.requests.filter(
		(entry) => entry.kind === "chat"
	);
	expect(
		chatRequests.some((entry) =>
			JSON.stringify(entry).includes("Inspect only API handlers.")
		)
	).toBe(true);
	expect(
		chatRequests.some((entry) =>
			JSON.stringify(entry).includes("Inspect only resource boundaries.")
		)
	).toBe(true);
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
					protocolVersion: 4,
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
	expect(JSON.stringify(reopenMessages)).toContain(
		"Inspect only resource boundaries."
	);
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
				protocolVersion: 4,
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
				protocolVersion: 4,
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

test("raw JSONL target switches retain background Sessions but stream only the active target", async () => {
	const switchAssembly = await createSessionCapabilities({
		connections: {
			authorize: async () => ({
				kind: "api-key" as const,
				apiKey: "switch-test-key",
			}),
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
		},
		cwd: workspace,
		databasePath: join(workspace, "session-switch.sqlite"),
		workspace,
	});
	const model = {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai" as const,
	};
	const createSeededSession = async (key: string) =>
		switchAssembly.store.createSession({
			agent: agentId("build"),
			message: {
				id: sessionMessageId(`${key}-seed`),
				parts: [{ text: `${key} seed`, type: "text" }],
				role: "user",
			},
			model,
			turnId: agentTurnId(`${key}-seed-turn`),
		});
	const firstSession = await createSeededSession("background");
	const secondSession = await createSeededSession("active");
	const initialized = Promise.withResolvers<void>();
	const firstBound = Promise.withResolvers<void>();
	const firstModelStarted = Promise.withResolvers<void>();
	const secondBound = Promise.withResolvers<void>();
	const secondModelStarted = Promise.withResolvers<void>();
	const secondModelCompleted = Promise.withResolvers<void>();
	const backgroundModelCompleted = Promise.withResolvers<void>();
	const firstRebound = Promise.withResolvers<void>();
	const thirdModelStarted = Promise.withResolvers<void>();
	const thirdModelCompleted = Promise.withResolvers<void>();
	const releaseFirstModel = Promise.withResolvers<void>();
	let firstModelHeld = false;
	let secondModelSeen = false;
	let thirdModelSeen = false;
	const previousBeforeStep = recorder.beforeStep;
	recorder.beforeStep = async (request) => {
		const latestUserText = request.messages
			.filter(({ role }) => role === "user")
			.at(-1)
			?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n");
		if (latestUserText === "pause the background Session" && !firstModelHeld) {
			firstModelHeld = true;
			firstModelStarted.resolve();
			await releaseFirstModel.promise;
		} else if (latestUserText === "run the active Session") {
			secondModelSeen = true;
			secondModelStarted.resolve();
		} else if (latestUserText === "run the background Session again") {
			thirdModelSeen = true;
			thirdModelStarted.resolve();
		}
	};
	const unsubscribeManager = switchAssembly.capabilities
		.getSessionHostManager()
		.onEvent((event) => {
			if (
				event.type === "agent-turn-event" &&
				event.sessionId === firstSession.id &&
				event.event.type === "agent-turn-completed"
			) {
				backgroundModelCompleted.resolve();
			}
		});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const initialize = `${request("initialize", "initialize", {
		capabilities: {},
		clientInfo: { name: "session-switch-test" },
		cwd: workspace,
		protocolVersion: 4,
	})}\n`;
	const openFirst = `${request("open-first", "session/open", {
		sessionId: firstSession.id,
	})}\n`;
	const submitFirst = `${request("submit-first", "session/submit", {
		submission: { text: "pause the background Session" },
	})}\n`;
	const openSecond = `${request("open-second", "session/open", {
		sessionId: secondSession.id,
	})}\n`;
	const submitSecond = `${request("submit-second", "session/submit", {
		submission: { text: "run the active Session" },
	})}\n`;
	const reopenFirst = `${request("reopen-first", "session/open", {
		sessionId: firstSession.id,
	})}\n`;
	const submitThird = `${request("submit-third", "session/submit", {
		submission: { text: "run the background Session again" },
	})}\n`;
	const shutdown = `${request("shutdown-switch-test", "server/shutdown", {})}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(initialize);
		await initialized.promise;
		yield new TextEncoder().encode(openFirst);
		await firstBound.promise;
		yield new TextEncoder().encode(submitFirst);
		await firstModelStarted.promise;
		yield new TextEncoder().encode(openSecond);
		await secondBound.promise;
		yield new TextEncoder().encode(submitSecond);
		await secondModelStarted.promise;
		await secondModelCompleted.promise;
		releaseFirstModel.resolve();
		await backgroundModelCompleted.promise;
		yield new TextEncoder().encode(reopenFirst);
		await firstRebound.promise;
		yield new TextEncoder().encode(submitThird);
		await thirdModelStarted.promise;
		await thirdModelCompleted.promise;
		yield new TextEncoder().encode(shutdown);
	})();
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	let exitCode: number | undefined;
	const run = runRpc({
		composeCapabilities: async () => switchAssembly,
		input,
		stderr: {
			write: (text: string): undefined => {
				stderrFrames.push(text);
			},
		},
		stdout: {
			write: (text: string): undefined => {
				stdoutFrames.push(text);
				const frame = JSON.parse(text) as {
					id?: string;
					method?: string;
					params?: {
						event?: {
							kind?: string;
							sessionId?: string;
						};
						state?: {
							sessionId?: string;
							status?: string;
						};
					};
				};
				if (frame.id === "initialize") {
					initialized.resolve();
				} else if (frame.id === "open-first") {
					firstBound.resolve();
				} else if (frame.id === "open-second") {
					secondBound.resolve();
				} else if (frame.id === "reopen-first") {
					firstRebound.resolve();
				}
				if (
					frame.method === "session/stateChanged" &&
					frame.params?.state?.status === "idle"
				) {
					if (
						secondModelSeen &&
						frame.params.state.sessionId === secondSession.id
					) {
						secondModelCompleted.resolve();
					}
					if (
						thirdModelSeen &&
						frame.params.state.sessionId === firstSession.id
					) {
						thirdModelCompleted.resolve();
					}
				}
			},
		},
	});
	try {
		exitCode = await run;
	} finally {
		releaseFirstModel.resolve();
		recorder.beforeStep = previousBeforeStep;
		unsubscribeManager();
		await switchAssembly.shutdown();
	}
	const frames = stdoutFrames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);
	expect(exitCode).toBe(0);
	expect(stderrFrames).toEqual([]);
	expect(frames.some((frame) => frame.id === "open-first")).toBe(true);
	expect(frames.some((frame) => frame.id === "open-second")).toBe(true);
	expect(frames.some((frame) => frame.id === "reopen-first")).toBe(true);
	expect(
		frames.some((frame) => {
			const params = frame.params as
				| { event?: { kind?: string; sessionId?: string } }
				| undefined;
			return (
				frame.method === "session/event" &&
				(params?.event?.kind === "background-agent-turn" ||
					params?.event?.kind === "delegated-agent-turn") &&
				params.event.sessionId === firstSession.id
			);
		})
	).toBe(false);
});

test("RPC reports a pending background approval after switching Sessions", async () => {
	const approvalRegistry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [
				{
					document: fromPartial<ConfigSnapshot["document"]>({
						agents: {
							build: { permission: { read: "ask" } },
						},
					}),
					path: join(workspace, "wincode.json"),
					scope: "project",
				},
			],
		})
	);
	const approvalAssembly = await createSessionCapabilities({
		connections: {
			authorize: async () => ({
				kind: "api-key" as const,
				apiKey: "approval-switch-key",
			}),
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
		},
		cwd: workspace,
		databasePath: join(workspace, "approval-switch.sqlite"),
		registry: approvalRegistry,
		workspace,
	});
	const model = {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai" as const,
	};
	const firstSession = await approvalAssembly.store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("approval-background-seed"),
			parts: [{ text: "seed", type: "text" }],
			role: "user",
		},
		model,
		turnId: agentTurnId("approval-background-seed-turn"),
	});
	const secondSession = await approvalAssembly.store.createSession({
		agent: agentId("build"),
		message: {
			id: sessionMessageId("approval-active-seed"),
			parts: [{ text: "seed", type: "text" }],
			role: "user",
		},
		model,
		turnId: agentTurnId("approval-active-seed-turn"),
	});
	const previousScript = recorder.stepScript;
	recorder.stepScript = async function* (request) {
		const latestUserText = request.messages
			.filter(({ role }) => role === "user")
			.at(-1)
			?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n");
		if (latestUserText === "request a background approval") {
			yield {
				input: { path: "package.json" },
				toolCallId: "rpc-background-approval-call",
				toolName: "read",
				type: "tool-call",
			};
			yield { type: "finish" };
			return;
		}
		yield { delta: "Active Session response.", type: "text-delta" };
		yield { type: "finish" };
	};
	const initialized = Promise.withResolvers<void>();
	const firstOpened = Promise.withResolvers<void>();
	const approvalVisible = Promise.withResolvers<void>();
	const secondOpened = Promise.withResolvers<void>();
	const noticeReceived = Promise.withResolvers<void>();
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const init = `${request("initialize", "initialize", {
		capabilities: {},
		clientInfo: { name: "background-approval-test" },
		cwd: workspace,
		protocolVersion: 4,
	})}\n`;
	const openFirst = `${request("open-first", "session/open", {
		sessionId: firstSession.id,
	})}\n`;
	const submit = `${request("submit-approval", "session/submit", {
		submission: { text: "request a background approval" },
	})}\n`;
	const openSecond = `${request("open-second", "session/open", {
		sessionId: secondSession.id,
	})}\n`;
	const shutdown = `${request("shutdown-approval-test", "server/shutdown", {})}\n`;
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(init);
		await initialized.promise;
		yield new TextEncoder().encode(openFirst);
		await firstOpened.promise;
		yield new TextEncoder().encode(submit);
		await approvalVisible.promise;
		yield new TextEncoder().encode(openSecond);
		await secondOpened.promise;
		await noticeReceived.promise;
		yield new TextEncoder().encode(shutdown);
	})();
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const run = runRpc({
		composeCapabilities: async () => approvalAssembly,
		input,
		stderr: {
			write: (text: string): undefined => {
				stderrFrames.push(text);
			},
		},
		stdout: {
			write: (text: string): undefined => {
				stdoutFrames.push(text);
				const frame = JSON.parse(text) as {
					id?: string;
					method?: string;
					params?: {
						event?: {
							kind?: string;
							pendingApprovalCount?: number;
							sessionId?: string;
						};
						state?: {
							approvals?: readonly unknown[];
							sessionId?: string;
						};
					};
				};
				if (frame.id === "initialize") {
					initialized.resolve();
				} else if (frame.id === "open-first") {
					firstOpened.resolve();
				} else if (frame.id === "open-second") {
					secondOpened.resolve();
				}
				if (
					frame.method === "session/stateChanged" &&
					frame.params?.state?.sessionId === firstSession.id &&
					(frame.params.state.approvals?.length ?? 0) > 0
				) {
					approvalVisible.resolve();
				}
				if (
					frame.method === "session/event" &&
					frame.params?.event?.kind === "session-approval-notice" &&
					frame.params.event.sessionId === firstSession.id
				) {
					noticeReceived.resolve();
				}
			},
		},
	});
	try {
		expect(await run).toBe(0);
	} finally {
		recorder.stepScript = previousScript;
		await approvalAssembly.shutdown();
	}
	const frames = stdoutFrames.map(
		(frame) => JSON.parse(frame) as Record<string, unknown>
	);
	const noticeFrame = frames.find((frame) => {
		const params = frame.params as
			| { event?: { kind?: string; sessionId?: string } }
			| undefined;
		return (
			frame.method === "session/event" &&
			params?.event?.kind === "session-approval-notice" &&
			params.event.sessionId === firstSession.id
		);
	});
	expect(stderrFrames).toEqual([]);
	expect(noticeFrame?.params).toMatchObject({
		event: {
			kind: "session-approval-notice",
			pendingApprovalCount: 1,
			sessionId: firstSession.id,
		},
	});
	expect(JSON.stringify(noticeFrame)).not.toContain("package.json");
	expect(JSON.stringify(noticeFrame)).not.toContain("toolCallId");
});

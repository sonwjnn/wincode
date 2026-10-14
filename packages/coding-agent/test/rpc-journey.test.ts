import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromPartial } from "@total-typescript/shoehorn";
import { createAgentRuntime } from "@wincode/agent-core";
import {
	createProviderCollection,
	type Provider,
	ProviderError,
	type ProviderModel,
} from "@wincode/ai/sdk";
import { buildAgentRegistry } from "../modules/agents/registry";
import { runRpc } from "../modules/application/rpc/runner";
import { SessionWriterLockFailureError } from "../modules/sessions/storage/session-writer-lock";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
} from "./support/identifiers";

const workspace = await fs.mkdtemp(path.join("/tmp", "wincode-rpc-journey-"));
const commandDirectory = path.join(workspace, ".wincode", "commands");
await fs.mkdir(commandDirectory, { recursive: true });
await Bun.write(
	path.join(commandDirectory, "review.md"),
	"---\ndescription: Review API changes\n---\nInspect only $ARGUMENTS."
);
const databasePath = path.join(workspace, "conversation.sqlite");

import {
	createFakeModelClient,
	createFakeModelClientRecorder,
	createFakeProviderCollection,
	installFakeModelClient,
} from "./support/e2e-fake-runtime";

const recorder = createFakeModelClientRecorder();
installFakeModelClient(recorder);

import { openSessionServices } from "../modules/sessions/host/session-services";
import { createDatabase } from "../modules/sessions/storage/client";
import { createDrizzleSessionStore } from "../modules/sessions/storage/drizzle-session-store";
import type { ConfigSnapshot } from "../shared/config/config-store";

afterAll(async () => {
	mock.restore();
	await fs.rm(workspace, { force: true, recursive: true });
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
	const assembly = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			connections: () => connections,
			createProviderCollection: () => createFakeProviderCollection(recorder),
		},
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
			thinkingLevel: "high",
		},
	})}\n`;
	const invalidCreate = `${request("invalid-create", "session/create", {
		initialSubmission: { text: "reject unsupported ThinkingLevel" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
			thinkingLevel: "minimal",
		},
	})}\n`;
	const legacyCreate = `${request("legacy-create", "session/create", {
		initialSubmission: { text: "reject legacy reasoningMode" },
		selection: {
			agentId: "build",
			model: { modelId: "gpt-5.6-luna", providerId: "openai" },
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
			`${invalidCreate}${legacyCreate}${create.slice(0, 11)}`
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
		composeServices: async () => assembly,
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
	const secondAssembly = await openSessionServices({
		policy: { cwd: workspace, databasePath, workspace },
		sources: {
			connections: () => connections,
			createProviderCollection: () => createFakeProviderCollection(recorder),
		},
	});
	const secondStdoutFrames: string[] = [];
	const secondStderrFrames: string[] = [];
	const secondExitCode = await runRpc({
		composeServices: async () => secondAssembly,
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
	expect(openState).toMatchObject({ selection: { thinkingLevel: "high" } });
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
				metadata: expect.objectContaining({ thinkingLevel: "high" }),
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
				record.outcome.kind === "user" && record.model.thinkingLevel === "high"
		)
	).toBe(true);
	const assistantRecord = records.find(
		(record) => record.outcome.kind === "assistant"
	);
	expect(assistantRecord?.model.thinkingLevel).toBe("high");
	expect(
		assistantRecord?.messages.some(
			(message) => message.metadata?.thinkingLevel === "high"
		)
	).toBe(true);
	expect(session.thinkingLevel).toBe("high");
});

test("RPC runs an explicitly selected Plugin Provider and emits a secret-free authentication failure", async () => {
	const authWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-plugin-auth-")
	);
	const fakeSecret = "rpc-fake-plugin-credential-do-not-project";
	const credentialReads = new Set<string>();
	const providerModel: ProviderModel = {
		capabilities: ["text", "tools"],
		limits: { maxOutputTokens: 128 },
		modelId: "auth-model-v1",
		protocolId: "fake-plugin-auth",
		providerId: "fake-plugin-auth",
	};
	const providerCollection = createProviderCollection({
		credentialStore: {
			delete: () => undefined,
			get: (providerId) => {
				credentialReads.add(providerId);
				return providerId === providerModel.providerId ? fakeSecret : undefined;
			},
			set: () => undefined,
		},
	});
	const provider: Provider = {
		id: providerModel.providerId,
		models: [providerModel],
		resolveAuthorization: () => {
			throw new ProviderError("authentication", fakeSecret);
		},
		async *streamChat() {
			yield { type: "finish" };
		},
	};
	providerCollection.register(provider);
	const agentRegistry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	let legacyProviderChecks = 0;
	const connections = {
		authorize: async () => {
			throw new Error("RPC must not authorize through legacy Connections.");
		},
		connect: async () => {
			throw new Error("RPC must not connect through legacy Connections.");
		},
		listProviders: async () => {
			legacyProviderChecks += 1;
			return [];
		},
	};
	const assembly = await openSessionServices({
		policy: {
			cwd: authWorkspace,
			databasePath: path.join(authWorkspace, "sessions.sqlite"),
			workspace: authWorkspace,
		},
		sources: {
			connections: () => connections,
			createProviderCollection: () => providerCollection,
			registry: () => agentRegistry,
		},
	});
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	const initialized = Promise.withResolvers<void>();
	const created = Promise.withResolvers<Record<string, unknown>>();
	const failed = Promise.withResolvers<Record<string, unknown>>();
	let failureEvent: Record<string, unknown> | undefined;
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdout = {
		write: (text: string): undefined => {
			stdoutFrames.push(text);
			const frame = JSON.parse(text) as Record<string, unknown>;
			if (frame.id === "initialize") {
				initialized.resolve();
			}
			if (frame.id === "create") {
				created.resolve(frame);
			}
			if (frame.method !== "session/event") {
				return;
			}
			const params = frame.params as Record<string, unknown> | undefined;
			const wrapper = params?.event as Record<string, unknown> | undefined;
			const event = wrapper?.event as Record<string, unknown> | undefined;
			if (event?.type === "agent-turn-failed") {
				failureEvent = event;
				failed.resolve(event);
			}
		},
	};
	const input = (async function* (): AsyncGenerator<Uint8Array> {
		yield new TextEncoder().encode(
			`${request("initialize", "initialize", {
				capabilities: {},
				clientInfo: { name: "plugin-auth-test" },
				cwd: authWorkspace,
				protocolVersion: 4,
			})}\n`
		);
		await initialized.promise;
		yield new TextEncoder().encode(
			`${request("create", "session/create", {
				initialSubmission: {
					text: "Send with a fake selected Plugin Provider.",
				},
				selection: {
					agentId: "build",
					model: {
						modelId: providerModel.modelId,
						providerId: providerModel.providerId,
					},
				},
			})}\n`
		);
		const createFrame = await created.promise;
		if (createFrame.error === undefined) {
			await Promise.race([failed.promise, Bun.sleep(2000)]);
		}
		yield new TextEncoder().encode(
			`${request("shutdown", "server/shutdown", {})}\n`
		);
	})();
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input,
			stderr: {
				write: (text: string): undefined => {
					stderrFrames.push(text);
				},
			},
			stdout,
		});
		const frames = stdoutFrames.map(
			(frame) => JSON.parse(frame) as Record<string, unknown>
		);
		const createFrame = frames.find((frame) => frame.id === "create");
		expect(exitCode).toBe(0);
		expect(createFrame?.error).toBeUndefined();
		expect(legacyProviderChecks).toBe(0);
		expect(failureEvent).toMatchObject({
			type: "agent-turn-failed",
			failure: {
				code: "authentication",
				details: {
					modelId: providerModel.modelId,
					providerId: providerModel.providerId,
				},
				message: "Model authentication failed.",
			},
		});
		expect([...credentialReads]).toEqual([providerModel.providerId]);
		expect(stdoutFrames.join("") + stderrFrames.join("")).not.toContain(
			fakeSecret
		);
		expect(stderrFrames).toEqual([]);
	} finally {
		await assembly.shutdown();
		await fs.rm(authWorkspace, { force: true, recursive: true });
	}
});

test("RPC maps a legacy Host to an actionable structured Provider SDK requirement", async () => {
	const legacyWorkspace = await fs.mkdtemp(
		path.join("/tmp", "wincode-rpc-legacy-runtime-")
	);
	const legacyRecorder = createFakeModelClientRecorder();
	let legacyRuntimeCalls = 0;
	let legacyConnectionChecks = 0;
	const legacyRuntime = () => {
		legacyRuntimeCalls += 1;
		return createAgentRuntime({
			modelClient: createFakeModelClient(legacyRecorder),
		});
	};
	const registry = buildAgentRegistry(
		fromPartial<ConfigSnapshot>({
			diagnostics: [],
			document: {},
			sourceFor: () => undefined,
			sources: [],
		})
	);
	const assembly = await openSessionServices({
		policy: {
			cwd: legacyWorkspace,
			databasePath: path.join(legacyWorkspace, "sessions.sqlite"),
			workspace: legacyWorkspace,
		},
		sources: {
			connections: () => ({
				authorize: async () => {
					throw new Error("RPC must not authorize legacy Connections.");
				},
				connect: async () => {
					throw new Error("RPC must not open a legacy connection prompt.");
				},
				listProviders: async () => {
					legacyConnectionChecks += 1;
					return [];
				},
			}),
			registry: () => registry,
			runtimeFactory: legacyRuntime,
		},
	});
	const request = (
		id: string,
		method: string,
		params: Record<string, unknown>
	): string => JSON.stringify({ id, jsonrpc: "2.0", method, params });
	const stdoutFrames: string[] = [];
	const stderrFrames: string[] = [];
	try {
		const exitCode = await runRpc({
			composeServices: async () => assembly,
			input: [
				new TextEncoder().encode(
					`${request("initialize", "initialize", {
						capabilities: {},
						clientInfo: { name: "legacy-host-test" },
						cwd: legacyWorkspace,
						protocolVersion: 4,
					})}\n`
				),
				new TextEncoder().encode(
					`${request("create", "session/create", {
						initialSubmission: { text: "Do not use legacy dispatch." },
						selection: {
							agentId: "build",
							model: { modelId: "gpt-5.6-luna", providerId: "openai" },
						},
					})}\n`
				),
				new TextEncoder().encode(
					`${request("shutdown", "server/shutdown", {})}\n`
				),
			],
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
		const createFrame = frames.find((frame) => frame.id === "create");
		expect(exitCode).toBe(0);
		expect(createFrame?.error).toMatchObject({
			data: {
				code: "provider_sdk_required",
				executionMode: "rpc",
				stage: "host",
			},
			message: expect.stringContaining(
				"Connect the Provider in Interactive Mode"
			),
		});
		expect(legacyRuntimeCalls).toBe(1);
		expect(legacyConnectionChecks).toBe(0);
		expect(legacyRecorder.requests).toEqual([]);
		expect(stderrFrames).toEqual([]);
	} finally {
		await assembly.shutdown();
		await fs.rm(legacyWorkspace, { force: true, recursive: true });
	}
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
	const conflictDatabasePath = path.join(workspace, "writer-conflict.sqlite");
	const ownerDatabase = createDatabase(conflictDatabasePath);
	const ownerStore = createDrizzleSessionStore(ownerDatabase.db, {
		attachmentRoot: path.join(workspace, "writer-conflict-attachments"),
		snapshotRoot: path.join(workspace, "writer-conflict-snapshots"),
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
	const rpcAssembly = await openSessionServices({
		policy: { cwd: workspace, databasePath: conflictDatabasePath, workspace },
		sources: {
			connections: () => connections,
		},
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
			composeServices: async () => rpcAssembly,
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
	const failureDatabasePath = path.join(
		workspace,
		"writer-lock-failure.sqlite"
	);
	const failureAssembly = await openSessionServices({
		policy: { cwd: workspace, databasePath: failureDatabasePath, workspace },
		sources: {
			connections: () => connections,
		},
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
			composeServices: async () => failureAssembly,
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
	const switchAssembly = await openSessionServices({
		policy: {
			cwd: workspace,
			databasePath: path.join(workspace, "session-switch.sqlite"),
			workspace,
		},
		sources: {
			connections: () => ({
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
			}),
			createProviderCollection: () => createFakeProviderCollection(recorder),
		},
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
		composeServices: async () => switchAssembly,
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

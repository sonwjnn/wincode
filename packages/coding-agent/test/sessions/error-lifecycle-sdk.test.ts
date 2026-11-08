import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTurnTerminalEvent } from "@wincode/agent-core";
import {
	createOpenAIProvider,
	createProviderCollection,
	type ProviderChatRequest,
	ProviderError,
	type ProviderModel,
} from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { createSessionSdkWithRuntime } from "@/modules/sessions/sdk";
import type {
	SessionSdkHandle,
	SessionSdkSnapshot,
} from "@/modules/sessions/sdk-contract";
import type { SessionSdkEvent } from "@/modules/sessions/session-events";
import {
	type ConfigStore,
	createConfigStore,
} from "@/shared/config/config-store";
import { modelId } from "../support/identifiers";
import { createInMemoryCredentialStore } from "../support/provider-stores";
import { removeTemporaryDirectory } from "../support/temporary-directory";

const root = await fs.mkdtemp(
	path.join(os.tmpdir(), "wincode-error-lifecycle-")
);
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });
const serverRequests: {
	authorization: string | null;
	body: { messages?: readonly Readonly<Record<string, unknown>>[] };
}[] = [];
type ErrorLifecycleResponse =
	| "authentication"
	| "filtered"
	| "request-timeout"
	| "stream-interrupted"
	| "success";
let responseScript: ErrorLifecycleResponse[] = [];
let summaryResponseScript: ErrorLifecycleResponse[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: async (request) => {
		if (new URL(request.url).pathname !== "/v1/chat/completions") {
			return new Response("not found", { status: 404 });
		}
		const body = (await request.json()) as {
			messages?: readonly Readonly<Record<string, unknown>>[];
		};
		serverRequests.push({
			authorization: request.headers.get("authorization"),
			body,
		});
		const isSummaryRequest = JSON.stringify(body.messages ?? []).includes(
			"You are Wincode's session summarizer."
		);
		const response = isSummaryRequest
			? (summaryResponseScript.shift() ?? "success")
			: (responseScript.shift() ?? "success");
		if (response === "authentication") {
			return Response.json(
				{ error: { message: "Invalid API key: provider-private-detail" } },
				{ status: 401 }
			);
		}
		if (response === "request-timeout") {
			return Response.json(
				{ error: { message: "Request timed out." } },
				{ status: 408 }
			);
		}
		if (response === "stream-interrupted") {
			return new Response(
				[
					`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial attempt text" } }] })}\n\n`,
					`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })}\n\n`,
				].join(""),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}
		const finishReason = response === "filtered" ? "content_filter" : "stop";
		const answer =
			response === "filtered" ? "Filtered partial" : "Recovered response";
		return new Response(
			[
				`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`,
				`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
				...(isSummaryRequest
					? [
							`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } })}\n\n`,
						]
					: []),
				"data: [DONE]\n\n",
			].join(""),
			{ headers: { "content-type": "text/event-stream" } }
		);
	},
});

const testModelId = modelId("error-lifecycle-test-model");
const testModel: ProviderModel = {
	capabilities: ["text", "tools"],
	modelId: testModelId,
	providerId: "openai",
	protocolId: "openai-chat",
};

const isTerminalEvent = (
	event: SessionSdkEvent
): event is AgentTurnTerminalEvent =>
	event.type === "agent-turn-completed" ||
	event.type === "agent-turn-failed" ||
	event.type === "agent-turn-cancelled" ||
	event.type === "agent-turn-interrupted";

const createErrorLifecycleSdk = (
	databaseFileName: string,
	model: ProviderModel = testModel,
	configStore?: ConfigStore,
	additionalModels: readonly ProviderModel[] = []
) =>
	createSessionSdkWithRuntime({
		createProviderCollection: () => {
			const collection = createProviderCollection({
				credentialStore: createInMemoryCredentialStore(
					new Map([
						["openai", { apiKey: "provider-test-key", kind: "api-key" }],
					])
				),
			});
			collection.register(
				createOpenAIProvider({
					baseUrl: `${server.url}v1`,
					models: [model, ...additionalModels],
				})
			);
			return Object.assign(collection, {
				getPluginProviderRegistrations: (): readonly [] => [],
			});
		},
		cwd: workspace,
		databasePath: path.join(root, databaseFileName),
		...(configStore === undefined ? {} : { configStore }),
		model: { modelId: modelId(model.modelId), providerId: model.providerId },
		pluginPaths: [],
		workspace,
	});

const createUsageFailureSdk = async (databaseFileName: string) => {
	const requests: ProviderChatRequest[] = [];
	let providerRequestCount = 0;
	const sdk = await createSessionSdkWithRuntime({
		createProviderCollection: () => {
			const collection = createProviderCollection({
				credentialStore: createInMemoryCredentialStore(
					new Map([
						["openai", { apiKey: "provider-test-key", kind: "api-key" }],
					])
				),
			});
			collection.register({
				id: "openai",
				models: [testModel],
				resolveAuthorization: () => ({ authorization: { kind: "fake" } }),
				streamChat(request) {
					requests.push(request);
					providerRequestCount += 1;
					return {
						async *[Symbol.asyncIterator]() {
							if (providerRequestCount === 1) {
								yield {
									type: "usage",
									usage: { inputTokens: 10, outputTokens: 1 },
								};
								throw new ProviderError(
									"transport",
									"private provider diagnostics"
								);
							}
							yield { delta: "Second answer", type: "text-delta" };
							yield {
								completion: { kind: "completed" },
								type: "finish",
							};
						},
					};
				},
			});
			return Object.assign(collection, {
				getPluginProviderRegistrations: (): readonly [] => [],
			});
		},
		cwd: workspace,
		databasePath: path.join(root, databaseFileName),
		model: { modelId: testModelId, providerId: testModel.providerId },
		pluginPaths: [],
		workspace,
	});
	return { requests, sdk };
};

const submitAndWait = async (
	handle: SessionSdkHandle,
	text: string,
	model?: ProviderModelSelection
): Promise<AgentTurnTerminalEvent> => {
	const terminal = Promise.withResolvers<AgentTurnTerminalEvent>();
	const unsubscribe = handle.onEvent((event) => {
		if (isTerminalEvent(event)) {
			terminal.resolve(event);
		}
	});
	try {
		const admission = await handle.prompt({
			text,
			...(model === undefined ? {} : { model }),
		});
		expect(admission.rejected).toBe(false);
		return await terminal.promise;
	} finally {
		unsubscribe();
	}
};

const waitForTurnIdle = async (handle: SessionSdkHandle): Promise<void> => {
	const idle = Promise.withResolvers<void>();
	const unsubscribe = handle.subscribe(({ turnActive }) => {
		if (!turnActive) {
			idle.resolve();
		}
	});
	try {
		await idle.promise;
	} finally {
		unsubscribe();
	}
};

afterAll(async () => {
	server.stop(true);
	await removeTemporaryDirectory(root);
});

test("reopening after authentication failure does not replay display-only error text", async () => {
	serverRequests.length = 0;
	responseScript = ["authentication", "success"];
	const model = testModel;
	const sdk = await createErrorLifecycleSdk("sessions.sqlite");
	let handle: SessionSdkHandle | undefined;
	let unsubscribeSnapshot: (() => void) | undefined;
	let latestSnapshot: SessionSdkSnapshot | undefined;
	try {
		const sessionId = await sdk.createEmptySession({
			model: { modelId: testModelId, providerId: model.providerId },
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		unsubscribeSnapshot = handle.subscribe((snapshot) => {
			latestSnapshot = snapshot;
		});
		const firstOutcome = await submitAndWait(handle, "first user prompt");
		expect(firstOutcome.type).toBe("agent-turn-failed");
		expect(JSON.stringify(latestSnapshot?.transcript)).toContain(
			"Model authentication failed."
		);
		expect(serverRequests).toHaveLength(1);
		expect(serverRequests[0]?.authorization).toBe("Bearer provider-test-key");

		unsubscribeSnapshot?.();
		unsubscribeSnapshot = undefined;
		await handle.dispose();
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		unsubscribeSnapshot = handle.subscribe((snapshot) => {
			latestSnapshot = snapshot;
		});
		const secondOutcome = await submitAndWait(
			handle,
			"another prompt after credentials are corrected"
		);
		expect(secondOutcome.type).toBe("agent-turn-completed");
		expect(serverRequests).toHaveLength(2);
		const secondRequestMessages = JSON.stringify(
			serverRequests[1]?.body.messages
		);
		expect(secondRequestMessages).toContain("first user prompt");
		expect(secondRequestMessages).toContain(
			"another prompt after credentials are corrected"
		);
		expect(secondRequestMessages).not.toContain("Model authentication failed.");
		expect(secondRequestMessages).not.toContain("provider-private-detail");

		const history = await sdk.readSessionHistoryPage(sessionId);
		expect(history.records.flatMap(({ messages }) => messages)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "assistant" }),
				expect.objectContaining({ role: "user" }),
			])
		);
	} finally {
		unsubscribeSnapshot?.();
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("a filtered Provider response is a failed Agent Turn and is not replayed", async () => {
	serverRequests.length = 0;
	responseScript = ["filtered", "success"];
	const sdk = await createErrorLifecycleSdk("filtered-response.sqlite");
	let handle: SessionSdkHandle | undefined;
	let unsubscribeSnapshot: (() => void) | undefined;
	let latestSnapshot: SessionSdkSnapshot | undefined;
	try {
		const sessionId = await sdk.createEmptySession({
			model: {
				modelId: testModelId,
				providerId: testModel.providerId,
			},
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		unsubscribeSnapshot = handle.subscribe((snapshot) => {
			latestSnapshot = snapshot;
		});
		const filteredOutcome = await submitAndWait(
			handle,
			"request a safe answer"
		);
		expect(filteredOutcome).toMatchObject({
			failure: {
				code: "filtered",
				message: "The model filtered its response.",
			},
			type: "agent-turn-failed",
		});
		expect(JSON.stringify(latestSnapshot?.transcript)).toContain(
			"The model filtered its response."
		);
		expect(serverRequests).toHaveLength(1);

		const recoveredOutcome = await submitAndWait(
			handle,
			"ask a different question"
		);
		expect(recoveredOutcome.type).toBe("agent-turn-completed");
		expect(serverRequests).toHaveLength(2);
		const nextRequestMessages = JSON.stringify(
			serverRequests[1]?.body.messages
		);
		expect(nextRequestMessages).toContain("request a safe answer");
		expect(nextRequestMessages).not.toContain("Filtered partial");
		expect(nextRequestMessages).not.toContain(
			"The model filtered its response."
		);
	} finally {
		unsubscribeSnapshot?.();
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("a request-scoped HTTP 408 retries through the public Session SDK", async () => {
	serverRequests.length = 0;
	responseScript = ["request-timeout", "success"];
	const sdk = await createErrorLifecycleSdk("request-timeout.sqlite");
	let handle: SessionSdkHandle | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	const events: SessionSdkEvent[] = [];
	try {
		const sessionId = await sdk.createEmptySession({
			model: { modelId: testModelId, providerId: testModel.providerId },
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		unsubscribeEvents = handle.onEvent((event) => events.push(event));
		const outcome = await submitAndWait(
			handle,
			"recover from a request-scoped provider timeout"
		);

		expect(outcome.type).toBe("agent-turn-completed");
		expect(serverRequests).toHaveLength(2);
		const attempts = events.filter(
			(event) => event.type === "model-step-started"
		);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]?.stepId).not.toBe(attempts[1]?.stepId);
		expect(events).toContainEqual(
			expect.objectContaining({
				failure: expect.objectContaining({ code: "network" }),
				type: "model-step-retry-scheduled",
			})
		);
	} finally {
		unsubscribeEvents?.();
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("Session SDK model request budgets include automatic retries", async () => {
	serverRequests.length = 0;
	responseScript = ["request-timeout", "success"];
	const sdk = await createErrorLifecycleSdk("request-budget.sqlite");
	let handle: SessionSdkHandle | undefined;
	let unsubscribe: (() => void) | undefined;
	const events: SessionSdkEvent[] = [];
	try {
		const sessionId = await sdk.createEmptySession({
			model: { modelId: testModelId, providerId: testModel.providerId },
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		await expect(
			handle.prompt({ maximumModelSteps: 0, text: "reject invalid budget" })
		).rejects.toThrow("positive safe integers");
		expect(serverRequests).toHaveLength(0);
		const terminal = Promise.withResolvers<AgentTurnTerminalEvent>();
		unsubscribe = handle.onEvent((event) => {
			events.push(event);
			if (isTerminalEvent(event)) {
				terminal.resolve(event);
			}
		});
		const admission = await handle.prompt({
			maximumModelSteps: 1,
			text: "stay within one Provider request",
		});
		expect(admission.rejected).toBe(false);
		const outcome = await terminal.promise;

		expect(outcome).toMatchObject({
			failure: { code: "network" },
			type: "agent-turn-failed",
		});
		expect(serverRequests).toHaveLength(1);
		expect(
			events.filter((event) => event.type === "model-step-retry-scheduled")
		).toHaveLength(0);
	} finally {
		unsubscribe?.();
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("exhausted retries include their count in the committed Session transcript", async () => {
	serverRequests.length = 0;
	responseScript = ["request-timeout", "request-timeout", "request-timeout"];
	const configStore = createConfigStore({
		homeRoot: path.join(root, "exhausted-retry-config"),
		trustedProjectRoots: [workspace],
	});
	await configStore.setValue(
		workspace,
		"global",
		["modelRetry", "baseDelayMs"],
		0
	);
	await configStore.setValue(
		workspace,
		"global",
		["modelRetry", "maxDelayMs"],
		0
	);
	await configStore.setValue(
		workspace,
		"global",
		["modelRetry", "maxRetries"],
		2
	);
	const sdk = await createErrorLifecycleSdk(
		"exhausted-retry-transcript.sqlite",
		testModel,
		configStore
	);
	let handle: SessionSdkHandle | undefined;
	let unsubscribe: (() => void) | undefined;
	let latestSnapshot: SessionSdkSnapshot | undefined;
	try {
		const sessionId = await sdk.createEmptySession({
			model: { modelId: testModelId, providerId: testModel.providerId },
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		unsubscribe = handle.subscribe((snapshot) => {
			latestSnapshot = snapshot;
		});
		const outcome = await submitAndWait(
			handle,
			"report the exhausted recovery count"
		);

		expect(outcome).toMatchObject({
			failure: { code: "network" },
			modelStepAttempts: [
				{ attempt: 1, retryDecision: "scheduled" },
				{ attempt: 2, retryDecision: "scheduled" },
				{ attempt: 3, retryDecision: "stopped" },
			],
			type: "agent-turn-failed",
		});
		expect(serverRequests).toHaveLength(3);
		expect(JSON.stringify(latestSnapshot?.transcript)).toContain(
			"Automatic recovery stopped after 2 retries."
		);
		const history = await sdk.readSessionHistoryPage(sessionId);
		const storedText = history.records
			.flatMap(({ messages }) => messages)
			.flatMap(({ parts }) =>
				parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
			)
			.join("\n");
		expect(storedText).toContain("Automatic recovery stopped after 2 retries.");
	} finally {
		unsubscribe?.();
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("compaction summary retries are visible through the Session SDK and account summary usage", async () => {
	serverRequests.length = 0;
	responseScript = [];
	summaryResponseScript = ["request-timeout", "success"];
	const seedModel: ProviderModel = {
		capabilities: ["text", "tools"],
		limits: { contextWindowTokens: 100_000, maxOutputTokens: 512 },
		modelId: "error-lifecycle-compaction-seed-model",
		providerId: "openai",
		protocolId: "openai-chat",
	};
	const compactionModel: ProviderModel = {
		capabilities: ["text", "tools"],
		limits: { contextWindowTokens: 32_768, maxOutputTokens: 512 },
		modelId: "error-lifecycle-compaction-model",
		providerId: "openai",
		protocolId: "openai-chat",
	};
	const configStore = createConfigStore({
		homeRoot: path.join(root, "compaction-config"),
		trustedProjectRoots: [workspace],
	});
	await configStore.setValue(
		workspace,
		"global",
		["compaction", "keepRecentTokens"],
		128
	);
	await configStore.setValue(
		workspace,
		"global",
		["compaction", "reserveTokens"],
		16_384
	);
	await configStore.setValue(
		workspace,
		"global",
		["modelRetry", "baseDelayMs"],
		0
	);
	await configStore.setValue(
		workspace,
		"global",
		["modelRetry", "maxDelayMs"],
		10
	);
	await configStore.setValue(
		workspace,
		"global",
		["modelRetry", "maxRetries"],
		1
	);
	const sdk = await createErrorLifecycleSdk(
		"compaction-summary-retry.sqlite",
		seedModel,
		configStore,
		[compactionModel]
	);
	let handle: SessionSdkHandle | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let unsubscribeSnapshot: (() => void) | undefined;
	const events: SessionSdkEvent[] = [];
	let latestSnapshot: SessionSdkSnapshot | undefined;
	try {
		const sessionId = await sdk.createEmptySession({
			model: {
				modelId: modelId(seedModel.modelId),
				providerId: seedModel.providerId,
			},
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		unsubscribeEvents = handle.onEvent((event) => events.push(event));
		unsubscribeSnapshot = handle.subscribe((snapshot) => {
			latestSnapshot = snapshot;
		});

		for (let index = 0; index < 6; index += 1) {
			const outcome = await submitAndWait(
				handle,
				`historical request ${index}: ${"historical context marker ".repeat(500)}`
			);
			expect(outcome.type).toBe("agent-turn-completed");
			await waitForTurnIdle(handle);
		}
		const compactedOutcome = await submitAndWait(
			handle,
			"request after lowering the context limit",
			{
				modelId: modelId(compactionModel.modelId),
				providerId: compactionModel.providerId,
			}
		);
		expect(compactedOutcome.type).toBe("agent-turn-completed");
		await waitForTurnIdle(handle);

		const summaryRequests = serverRequests.filter(({ body }) =>
			JSON.stringify(body.messages ?? []).includes(
				"You are Wincode's session summarizer."
			)
		);
		expect(summaryRequests).toHaveLength(2);
		const summaryAttempts = events.filter(
			(event) => event.type === "compaction-summary-attempt-started"
		);
		expect(summaryAttempts).toHaveLength(2);
		expect(summaryAttempts[0]?.stepId).not.toBe(summaryAttempts[1]?.stepId);
		expect(events).toContainEqual(
			expect.objectContaining({
				failure: expect.objectContaining({ code: "network" }),
				type: "compaction-summary-retry-scheduled",
			})
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				outcome: "success",
				type: "compaction-summary-retry-ended",
			})
		);
		expect(JSON.stringify(latestSnapshot)).not.toContain(
			"Partial attempt text"
		);
		const statistics = await sdk.getSessionStatistics(sessionId);
		expect(statistics.usage.auxiliary.inputTokens).toBeGreaterThanOrEqual(20);
		expect(statistics.usage.auxiliary.outputTokens).toBeGreaterThanOrEqual(2);
	} finally {
		unsubscribeEvents?.();
		unsubscribeSnapshot?.();
		summaryResponseScript = [];
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("a truncated provider stream retries without leaking partial output into the retry context", async () => {
	serverRequests.length = 0;
	responseScript = ["stream-interrupted", "success"];
	const sdk = await createErrorLifecycleSdk("interrupted-stream.sqlite");
	let handle: SessionSdkHandle | undefined;
	let unsubscribeSnapshot: (() => void) | undefined;
	let unsubscribeEvents: (() => void) | undefined;
	let latestSnapshot: SessionSdkSnapshot | undefined;
	const events: SessionSdkEvent[] = [];
	try {
		const sessionId = await sdk.createEmptySession({
			model: { modelId: testModelId, providerId: testModel.providerId },
		});
		handle = await sdk.openSession(sessionId, { autoContinue: false });
		unsubscribeSnapshot = handle.subscribe((snapshot) => {
			latestSnapshot = snapshot;
		});
		unsubscribeEvents = handle.onEvent((event) => events.push(event));
		const outcome = await submitAndWait(
			handle,
			"recover after a partial provider stream"
		);

		expect(outcome.type).toBe("agent-turn-completed");
		expect(serverRequests).toHaveLength(2);
		expect(serverRequests[1]?.body.messages).toEqual(
			serverRequests[0]?.body.messages
		);
		const modelSteps = events.filter(
			(event) => event.type === "model-step-started"
		);
		expect(modelSteps).toHaveLength(2);
		expect(modelSteps[0]?.stepId).not.toBe(modelSteps[1]?.stepId);
		const retryContext = JSON.stringify(serverRequests[1]?.body.messages);
		expect(retryContext).not.toContain("Partial attempt text");
		const transcript = JSON.stringify(latestSnapshot?.transcript);
		expect(transcript).toContain("Recovered response");
		expect(transcript).not.toContain("Partial attempt text");
		const history = await sdk.readSessionHistoryPage(sessionId);
		const completedRecord = history.records.find(
			(record) =>
				record.outcome.kind === "assistant" &&
				record.outcome.terminal.kind === "completed"
		);
		expect(completedRecord?.outcome).toMatchObject({
			kind: "assistant",
			terminal: {
				kind: "completed",
				modelStepAttempts: [
					{ attempt: 1, partialOutput: { text: "Partial attempt text" } },
				],
			},
		});
	} finally {
		unsubscribeSnapshot?.();
		unsubscribeEvents?.();
		await handle?.dispose();
		await sdk.dispose();
	}
});

test("usage from a recovered billed attempt is persisted once across reopen", async () => {
	const { requests, sdk } = await createUsageFailureSdk("usage-failure.sqlite");
	let handle: SessionSdkHandle | undefined;
	try {
		const sessionId = await sdk.createEmptySession({
			model: { modelId: testModelId, providerId: testModel.providerId },
		});
		const initialHandle = await sdk.openSession(sessionId, {
			autoContinue: false,
		});
		handle = initialHandle;
		const failedOutcome = await submitAndWait(
			initialHandle,
			"bill this request and then fail"
		);
		const expectedUsage = {
			inputTokens: 10,
			outputTokens: 1,
			totalTokens: 11,
		};

		expect(failedOutcome).toMatchObject({
			type: "agent-turn-completed",
			usage: expectedUsage,
		});
		expect(requests).toHaveLength(2);
		const history = await sdk.readSessionHistoryPage(sessionId);
		const completedRecord = history.records.find(
			(record) =>
				record.outcome.kind === "assistant" &&
				record.outcome.terminal.kind === "completed"
		);
		expect(completedRecord?.outcome).toMatchObject({
			kind: "assistant",
			terminal: {
				kind: "completed",
				modelStepAttempts: [
					{
						attempt: 1,
						retryDecision: "scheduled",
						usage: expectedUsage,
					},
				],
				usage: expectedUsage,
			},
		});
		expect(completedRecord?.messages[0]?.metadata?.usage).toEqual(
			expectedUsage
		);
		expect(JSON.stringify(history.records)).not.toContain(
			"private provider diagnostics"
		);

		await initialHandle.dispose();
		const reopenedHandle = await sdk.openSession(sessionId, {
			autoContinue: false,
		});
		handle = reopenedHandle;
		const recoveredOutcome = await submitAndWait(
			reopenedHandle,
			"continue after reopening"
		);
		expect(recoveredOutcome.type).toBe("agent-turn-completed");
		expect(requests).toHaveLength(3);
		const recoveredContext = JSON.stringify(requests[2]?.messages);
		expect(recoveredContext).toContain("bill this request and then fail");
		expect(recoveredContext).toContain("continue after reopening");
		expect(recoveredContext).not.toContain("The model connection failed.");
		expect(recoveredContext).not.toContain("private provider diagnostics");
	} finally {
		await handle?.dispose();
		await sdk.dispose();
	}
});

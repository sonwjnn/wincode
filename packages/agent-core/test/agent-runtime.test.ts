import { expect, test } from "bun:test";
import {
	type AgentTurn,
	type AgentTurnEvent,
	agentIdSchema,
	createAgentRuntime,
	createAgentTurnMessage,
	createStatefulAgent,
	type ModelStepObserver,
	type ResolvedTool,
	type ToolCallId,
	type ToolDefinition,
	toAgentTurnId,
	toModelId,
	toSessionMessageId,
} from "@wincode/agent-core";
import type { ModelUsage } from "@wincode/ai";
import {
	type ChatRequest,
	type CredentialStore,
	createProviderCollection,
	type Provider,
	type ProviderChatEvent,
	type ProviderChatRequest,
	type ProviderCollection,
	ProviderError,
} from "@wincode/ai";
import { z } from "zod";

const buildTurn = (tools: readonly ResolvedTool[] = []): AgentTurn => ({
	agent: {
		displayName: "Build",
		id: agentIdSchema.parse("build"),
		instructions: "Implement the request.",
		role: "primary",
	},
	id: toAgentTurnId("turn-native-runtime"),
	input: {
		messages: [
			{
				id: toSessionMessageId("message-user"),
				parts: [{ text: "Inspect the file", type: "text" }],
				role: "user",
			},
		],
	},
	model: {
		modelId: toModelId("sdk-model"),
		providerId: "test-provider",
	},
	tools,
});

const consume = async (
	stream: AsyncIterable<AgentTurnEvent>
): Promise<AgentTurnEvent[]> => {
	const events: AgentTurnEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
};

const scriptedProvider = (
	script: (
		request: ProviderChatRequest,
		index: number,
		signal: AbortSignal | undefined
	) => AsyncIterable<ProviderChatEvent>
): {
	providerCollection: ProviderCollection;
	requests: ProviderChatRequest[];
} => {
	const requests: ProviderChatRequest[] = [];
	const providerCollection = createProviderCollection();
	providerCollection.register({
		id: "test-provider",
		models: [
			{
				capabilities: ["file", "image", "reasoning", "text", "tools"],
				modelId: "sdk-model",
				promptCacheRetentionTiers: ["long", "short"],
				reasoningEfforts: [
					"off",
					"minimal",
					"low",
					"medium",
					"high",
					"xhigh",
					"max",
				],
				protocolId: "test-protocol",
				providerId: "test-provider",
			},
		],
		resolveAuthorization: () => ({ authorization: { kind: "fake" } }),
		streamChat(request, { signal }) {
			requests.push(request);
			return script(request, requests.length - 1, signal);
		},
	});
	return { providerCollection, requests };
};

const scriptedEvents = (
	...parts: ProviderChatEvent[]
): AsyncIterable<ProviderChatEvent> => ({
	async *[Symbol.asyncIterator]() {
		yield* parts;
	},
});

const readDefinition = {
	description: "Read a UTF-8 text file.",
	inputSchema: z.object({ path: z.string() }),
	name: "read",
} satisfies ToolDefinition;

test("Agent Runtime streams model output and reports normalized step usage", async () => {
	const { providerCollection } = scriptedProvider(() =>
		scriptedEvents(
			{ delta: "Hello", type: "text-delta" },
			{ delta: " world", type: "text-delta" },
			{
				type: "usage",
				usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
			},
			{ type: "finish" }
		)
	);
	const events = await consume(
		createAgentRuntime({ providerCollection }).run(buildTurn())
	);

	expect(events.map(({ type }) => type)).toEqual([
		"agent-turn-started",
		"model-step-started",
		"text-delta",
		"text-delta",
		"model-step-finished",
		"agent-turn-completed",
	]);
	expect(events.filter(({ type }) => type === "text-delta")).toMatchObject([
		{ delta: "Hello" },
		{ delta: " world" },
	]);
	expect(events.at(-1)).toMatchObject({
		type: "agent-turn-completed",
		usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
	});
});

test("Agent Runtime isolates Session request observers from active Turns", async () => {
	const { providerCollection, requests } = scriptedProvider(() =>
		scriptedEvents(
			{ type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
			{ type: "finish" }
		)
	);
	const started: ChatRequest[] = [];
	const finished: {
		request: ChatRequest;
		usage: ModelUsage | undefined;
	}[] = [];
	const events = await consume(
		createAgentRuntime({ providerCollection }).run(buildTurn(), {
			modelStepObserver: {
				onModelStepFinished: (request, usage) => {
					finished.push({ request, usage });
					throw new Error("usage observer failed");
				},
				onModelStepStarted: (request) => {
					started.push(request);
					throw new Error("request observer failed");
				},
			},
		})
	);

	expect(events.at(-1)).toMatchObject({ type: "agent-turn-completed" });
	expect(requests).toHaveLength(1);
	expect(started).toHaveLength(1);
	expect(started[0]).toMatchObject({
		modelId: "sdk-model",
		providerId: "test-provider",
	});
	expect(finished).toHaveLength(1);
	expect(finished[0]?.request).toBe(started[0]);
	expect(finished[0]?.usage).toEqual({
		inputTokens: 2,
		outputTokens: 1,
		totalTokens: 3,
	});
});

test("Agent Runtime forwards the Session-stable prompt-cache key to each Model Step", async () => {
	const { providerCollection, requests } = scriptedProvider(() =>
		scriptedEvents(
			{ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
			{ type: "finish" }
		)
	);
	await consume(
		createAgentRuntime({ providerCollection }).run(buildTurn(), {
			promptCacheKey: "wincode-session:session-123",
		})
	);

	expect(requests).toHaveLength(1);
	expect(requests[0]?.promptCacheKey).toBe("wincode-session:session-123");
});

test("SDK-backed Agent Runtime forwards request controls to the fake Provider", async () => {
	const requests: Parameters<Provider["streamChat"]>[0][] = [];
	const providers = createProviderCollection();
	providers.register({
		id: "test-provider",
		models: [
			{
				capabilities: ["reasoning", "text"],
				modelId: "sdk-controls-model",
				protocolId: "test-protocol",
				providerId: "test-provider",
			},
		],
		resolveAuthorization: () => ({ authorization: { kind: "test" } }),
		async *streamChat(request) {
			requests.push(request);
			yield { delta: "Controls arrived.", type: "text-delta" };
		},
	});
	await providers.setCredential("test-provider", "fake-sdk-credential");
	const events = await consume(
		createAgentRuntime({ providerCollection: providers }).run(
			{
				...buildTurn(),
				model: {
					maxOutputTokens: 321,
					modelId: toModelId("sdk-controls-model"),
					promptCacheEnabled: true,
					promptCacheRetention: "long",
					providerId: "test-provider",
					thinkingLevel: "high",
				},
			},
			{
				cacheWarming: true,
				promptCacheKey: "wincode-session:controls-session",
			}
		)
	);

	expect(events.at(-1)).toMatchObject({ type: "agent-turn-completed" });
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		cacheRetention: "long",
		cacheWarming: true,
		maxOutputTokens: 321,
		promptCacheKey: "wincode-session:controls-session",
		reasoningEffort: "high",
	});
});

test("SDK Agent Runtime forwards explicit reasoning off and leaves unset effort absent", async () => {
	const requests: Parameters<Provider["streamChat"]>[0][] = [];
	const providers = createProviderCollection();
	providers.register({
		id: "test-provider",
		models: [
			{
				capabilities: ["reasoning", "text"],
				modelId: "sdk-reasoning-model",
				protocolId: "test-protocol",
				providerId: "test-provider",
			},
		],
		resolveAuthorization: () => ({ authorization: { kind: "test" } }),
		async *streamChat(request) {
			requests.push(request);
			yield { type: "finish" };
		},
	});
	await providers.setCredential("test-provider", "fake-sdk-credential");
	const runtime = createAgentRuntime({ providerCollection: providers });
	const turnFor = (thinkingLevel?: "off"): AgentTurn => ({
		...buildTurn(),
		model: {
			modelId: toModelId("sdk-reasoning-model"),
			providerId: "test-provider",
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		},
	});

	await consume(runtime.run(turnFor("off")));
	await consume(runtime.run(turnFor()));

	expect(requests).toHaveLength(2);
	expect(requests[0]?.reasoningEffort).toBe("off");
	expect(requests[1]?.reasoningEffort).toBeUndefined();
});

test("SDK provider failures map safely and never complete an Agent Turn", async () => {
	const providerId = "test-provider";
	const sdkModelId = "sdk-failure-model";
	type FailureScenario = Readonly<{
		credentialStoreFailure?: boolean;
		expectedCode: string;
		expectedRetry: string;
		name: string;
		providerFailure?: ProviderError;
		registerProvider?: boolean;
		requestModelId: string;
		requestProviderId: string;
		tool?: boolean;
	}>;
	const scenarios: readonly FailureScenario[] = [
		{
			expectedCode: "invalid-request",
			expectedRetry: "never",
			name: "unregistered provider",
			registerProvider: false,
			requestModelId: sdkModelId,
			requestProviderId: "missing-provider",
		},
		{
			expectedCode: "invalid-request",
			expectedRetry: "never",
			name: "unavailable model",
			requestModelId: "missing-model",
			requestProviderId: providerId,
		},
		{
			expectedCode: "invalid-request",
			expectedRetry: "never",
			name: "unsupported tool capability",
			requestModelId: sdkModelId,
			requestProviderId: providerId,
			tool: true,
		},
		{
			expectedCode: "authentication",
			expectedRetry: "never",
			name: "provider authentication failure",
			providerFailure: new ProviderError(
				"authentication",
				"private provider detail"
			),
			requestModelId: sdkModelId,
			requestProviderId: providerId,
		},
		{
			expectedCode: "unknown",
			expectedRetry: "never",
			name: "credential store failure",
			credentialStoreFailure: true,
			requestModelId: sdkModelId,
			requestProviderId: providerId,
		},
		{
			expectedCode: "unknown",
			expectedRetry: "never",
			name: "provider failure",
			providerFailure: new ProviderError("provider", "private provider detail"),
			requestModelId: sdkModelId,
			requestProviderId: providerId,
		},
		{
			expectedCode: "context-overflow",
			expectedRetry: "with-changes",
			name: "provider context overflow",
			providerFailure: new ProviderError(
				"provider",
				"The prompt exceeds the model context window."
			),
			requestModelId: sdkModelId,
			requestProviderId: providerId,
		},
		{
			expectedCode: "network",
			expectedRetry: "after-delay",
			name: "transport failure",
			providerFailure: new ProviderError(
				"transport",
				"private transport detail"
			),
			requestModelId: sdkModelId,
			requestProviderId: providerId,
		},
	];

	for (const scenario of scenarios) {
		const credentialStore: CredentialStore | undefined =
			scenario.credentialStoreFailure
				? {
						delete: () => undefined,
						list: () => [],
						modify: () => {
							throw new Error("private credential store detail");
						},
						read: () => {
							throw new Error("private credential store detail");
						},
					}
				: undefined;
		const providers = createProviderCollection(
			credentialStore === undefined ? {} : { credentialStore }
		);
		if (scenario.registerProvider !== false) {
			providers.register({
				id: providerId,
				models: [
					{
						capabilities: scenario.tool ? ["text"] : ["text", "tools"],
						modelId: sdkModelId,
						protocolId: "test-protocol",
						providerId,
					},
				],
				resolveAuthorization: () => ({ authorization: { kind: "test" } }),
				async *streamChat() {
					if (scenario.providerFailure !== undefined) {
						throw scenario.providerFailure;
					}
					yield { delta: "unexpected success", type: "text-delta" };
				},
			});
		}
		const turn: AgentTurn = {
			...buildTurn(
				scenario.tool
					? [
							{
								definition: readDefinition,
								execute: async () => ({
									output: { content: "source text" },
									type: "success",
								}),
							},
						]
					: []
			),
			model: {
				modelId: toModelId(scenario.requestModelId),
				providerId: scenario.requestProviderId,
			},
		};
		const events = await consume(
			createAgentRuntime({ providerCollection: providers }).run(turn)
		);
		const terminal = events.at(-1);

		expect(terminal, scenario.name).toMatchObject({
			failure: {
				code: scenario.expectedCode,
				details: {
					modelId: scenario.requestModelId,
					providerId: scenario.requestProviderId,
				},
				retry: scenario.expectedRetry,
				source: "model",
			},
			type: "agent-turn-failed",
		});
		expect(
			events.filter(({ type }) => type === "agent-turn-completed")
		).toEqual([]);
		expect(JSON.stringify(terminal)).not.toContain("private");
	}
});

test("SDK-backed Agent Runtime delivers late steering using Provider Model identity", async () => {
	const providerModel = {
		capabilities: ["text", "tools"] as const,
		modelId: "sdk-model",
		protocolId: "test-protocol",
		providerId: "test-provider",
	};
	const requests: Parameters<Provider["streamChat"]>[0][] = [];
	const providers = createProviderCollection();
	providers.register({
		id: "test-provider",
		models: [providerModel],
		resolveAuthorization: () => ({ authorization: { kind: "test" } }),
		async *streamChat(request) {
			requests.push(request);
			if (requests.length === 1) {
				yield {
					input: { path: "src/main.ts" },
					toolCallId: "sdk-read-call",
					toolName: "read",
					type: "tool-call",
				};
				yield {
					type: "usage",
					usage: { inputTokens: 10, outputTokens: 4 },
				};
				yield { continuation: { responseId: "sdk-step-one" }, type: "finish" };
				return;
			}
			yield { delta: "Continued after steering.", type: "text-delta" };
			yield {
				type: "usage",
				usage: { inputTokens: 14, outputTokens: 3 },
			};
			yield { type: "finish" };
		},
	});
	await providers.setCredential("test-provider", "fake-sdk-credential");
	const tool: ResolvedTool = {
		definition: readDefinition,
		execute: async () => ({
			output: { content: "source text" },
			type: "success",
		}),
	};
	const turn: AgentTurn = {
		...buildTurn([tool]),
		model: { modelId: toModelId("sdk-model"), providerId: "test-provider" },
	};
	const steering = createAgentTurnMessage(
		"user",
		"Focus on the error path.",
		toSessionMessageId("sdk-steering-message")
	);
	const pendingSteering = [steering];
	type ObservedChatRequest = Parameters<
		ModelStepObserver["onModelStepStarted"]
	>[0];
	const observedStarts: ObservedChatRequest[] = [];
	const observedFinishes: {
		request: ObservedChatRequest;
		inputTokens?: number;
		outputTokens?: number;
	}[] = [];
	const events = await consume(
		createAgentRuntime({ providerCollection: providers }).run(turn, {
			modelStepObserver: {
				onModelStepFinished: (request, usage) => {
					observedFinishes.push({
						request,
						inputTokens: usage?.inputTokens,
						outputTokens: usage?.outputTokens,
					});
				},
				onModelStepStarted: (request) => observedStarts.push(request),
			},
			takeSteeringMessages: () => pendingSteering.splice(0),
		})
	);

	expect(events.map(({ type }) => type)).toEqual([
		"agent-turn-started",
		"model-step-started",
		"tool-call-started",
		"tool-call-finished",
		"model-step-finished",
		"model-step-started",
		"text-delta",
		"model-step-finished",
		"agent-turn-completed",
	]);
	expect(requests).toHaveLength(2);
	expect(observedStarts).toHaveLength(2);
	expect(observedFinishes).toMatchObject([
		{ inputTokens: 10, outputTokens: 4 },
		{ inputTokens: 14, outputTokens: 3 },
	]);
	for (const request of observedStarts) {
		expect(request).toMatchObject({
			modelId: "sdk-model",
			providerId: "test-provider",
		});
		expect("target" in request).toBe(false);
	}
	expect(requests[1]?.messages.map(({ role }) => role)).toEqual([
		"user",
		"assistant",
		"tool",
		"user",
	]);
	expect(requests[1]?.messages[1]).toMatchObject({
		continuation: { responseId: "sdk-step-one" },
		role: "assistant",
	});
	expect(requests[1]?.messages[2]).toMatchObject({
		content: [
			{
				output: { content: "source text" },
				toolCallId: "sdk-read-call",
				type: "tool-result",
			},
		],
		role: "tool",
	});
	expect(requests[1]?.messages[3]?.content).toEqual([
		{ text: "Focus on the error path.", type: "text" },
	]);
	expect(events.at(-1)).toMatchObject({
		type: "agent-turn-completed",
		usage: { inputTokens: 24, outputTokens: 7, totalTokens: 31 },
	});
});

test("ProviderCollection abort without caller cancellation cancels the Agent Turn", async () => {
	const providers = createProviderCollection();
	providers.register({
		id: "test-provider",
		models: [
			{
				capabilities: ["text"],
				modelId: "sdk-abort-model",
				protocolId: "test-protocol",
				providerId: "test-provider",
			},
		],
		resolveAuthorization: () => ({ authorization: { kind: "test" } }),
		async *streamChat() {
			yield { delta: "Partial output.", type: "text-delta" };
			throw new DOMException("provider abort", "AbortError");
		},
	});
	await providers.setCredential("test-provider", "fake-sdk-credential");
	const events = await consume(
		createAgentRuntime({ providerCollection: providers }).run({
			...buildTurn(),
			model: {
				modelId: toModelId("sdk-abort-model"),
				providerId: "test-provider",
			},
		})
	);

	expect(events.map(({ type }) => type)).toEqual([
		"agent-turn-started",
		"model-step-started",
		"text-delta",
		"agent-turn-cancelled",
	]);
});

test("Agent Runtime delivers steering after tool results and continues the same turn", async () => {
	const executionRequests: {
		input: unknown;
		signal?: AbortSignal;
		toolCallId: ToolCallId;
	}[] = [];
	const tool: ResolvedTool = {
		definition: readDefinition,
		execute: async (request, options) => {
			executionRequests.push({ ...request, signal: options?.signal });
			return { output: { content: "source text" }, type: "success" };
		},
	};
	const { providerCollection, requests } = scriptedProvider(
		(_request, index) =>
			index === 0
				? scriptedEvents(
						{
							input: { path: "src/main.ts" },
							toolCallId: "call-read",
							toolName: "read",
							type: "tool-call",
						},
						{ type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
						{ type: "finish" }
					)
				: scriptedEvents(
						{ delta: "Found it.", type: "text-delta" },
						{ type: "usage", usage: { inputTokens: 14, outputTokens: 3 } },
						{ type: "finish" }
					)
	);
	const steering = createAgentTurnMessage(
		"user",
		"Focus on the error path.",
		toSessionMessageId("steering-message")
	);
	const pendingSteering = [steering];
	const events = await consume(
		createAgentRuntime({ providerCollection }).run(buildTurn([tool]), {
			takeSteeringMessages: () => pendingSteering.splice(0),
		})
	);

	expect(events.map(({ type }) => type)).toEqual([
		"agent-turn-started",
		"model-step-started",
		"tool-call-started",
		"tool-call-finished",
		"model-step-finished",
		"model-step-started",
		"text-delta",
		"model-step-finished",
		"agent-turn-completed",
	]);
	expect(executionRequests).toMatchObject([
		{ input: { path: "src/main.ts" }, toolCallId: "call-read" },
	]);
	expect(requests).toHaveLength(2);
	const secondStepMessages = requests[1]?.messages;
	expect(secondStepMessages?.map(({ role }) => role)).toEqual([
		"user",
		"assistant",
		"tool",
		"user",
	]);
	expect(secondStepMessages?.[2]?.content).toEqual([
		{
			output: { content: "source text" },
			toolCallId: "call-read",
			toolName: "read",
			type: "tool-result",
		},
	]);
	expect(secondStepMessages?.[3]?.content).toEqual([
		{ text: "Focus on the error path.", type: "text" },
	]);
	expect(events.at(-1)).toMatchObject({
		type: "agent-turn-completed",
		usage: { inputTokens: 24, outputTokens: 7, totalTokens: 31 },
	});
});

test("pending steering continues the same turn after a text-only model step", async () => {
	const turn = buildTurn();
	const steering = [
		createAgentTurnMessage(
			"user",
			"Use the corrected request.",
			toSessionMessageId("steering-text-only")
		),
	];
	const { providerCollection, requests } = scriptedProvider((_request, index) =>
		scriptedEvents(
			{
				delta: index === 0 ? "Original answer." : "Corrected answer.",
				type: "text-delta",
			},
			{ type: "usage", usage: { inputTokens: 10, outputTokens: 4 } },
			{ type: "finish" }
		)
	);
	const events = await consume(
		createAgentRuntime({ providerCollection }).run(turn, {
			takeSteeringMessages: () => steering.splice(0),
		})
	);

	expect(requests).toHaveLength(2);
	expect(requests[1]?.messages).toMatchObject([
		{ role: "user", content: [{ type: "text", text: "Inspect the file" }] },
		{
			role: "assistant",
			content: [{ type: "text", text: "Original answer." }],
		},
		{
			role: "user",
			content: [{ type: "text", text: "Use the corrected request." }],
		},
	]);
	expect(
		events.filter(({ type }) => type === "model-step-started")
	).toMatchObject([{ turnId: turn.id }, { turnId: turn.id }]);
	expect(events.filter(({ type }) => type === "agent-turn-completed")).toEqual([
		expect.objectContaining({
			turnId: turn.id,
			usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
		}),
	]);
});
test("late steering committed during the final safe-boundary read continues the current turn", async () => {
	const steeringReadStarted = Promise.withResolvers<void>();
	const releaseSteeringRead = Promise.withResolvers<void>();
	const steering = createAgentTurnMessage(
		"user",
		"Correct the parent before it completes.",
		toSessionMessageId("late-steering")
	);
	const { providerCollection, requests } = scriptedProvider((_request, index) =>
		scriptedEvents(
			{
				delta:
					index === 0 ? "The parent response." : "The steering was handled.",
				type: "text-delta",
			},
			{ type: "finish" }
		)
	);
	let steeringReadCount = 0;
	const statefulAgent = createStatefulAgent({
		runtime: createAgentRuntime({ providerCollection }),
	});
	const runningTurn = consume(
		statefulAgent.run(buildTurn(), {
			takeSteeringMessages: async () => {
				steeringReadCount += 1;
				if (steeringReadCount === 1) {
					return [];
				}
				steeringReadStarted.resolve();
				await releaseSteeringRead.promise;
				return [steering];
			},
		})
	);

	try {
		await steeringReadStarted.promise;
		releaseSteeringRead.resolve();
		await runningTurn;

		expect(requests).toHaveLength(2);
		expect(
			requests[1]?.messages.map((message) => ({
				role: message.role,
				text: message.content
					.flatMap((part) => (part.type === "text" ? [part.text] : []))
					.join("\n"),
			}))
		).toEqual([
			{ role: "user", text: "Inspect the file" },
			{ role: "assistant", text: "The parent response." },
			{ role: "user", text: "Correct the parent before it completes." },
		]);
	} finally {
		releaseSteeringRead.resolve();
		await statefulAgent.shutdown();
	}
});

test("Stateful Agent delivers queued steering at safe boundaries after tool results", async () => {
	const toolStarted = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();
	const executionInputs: unknown[] = [];
	const observedPrompts: { role: string; text: string }[][] = [];
	const tool: ResolvedTool = {
		definition: readDefinition,
		execute: async (request) => {
			toolStarted.resolve();
			await releaseTool.promise;
			executionInputs.push(request.input);
			return { output: { content: "source text" }, type: "success" };
		},
	};
	const { providerCollection, requests } = scriptedProvider(
		(request, index) => {
			observedPrompts.push(
				request.messages.map(({ content, role }) => ({
					role,
					text: content
						.flatMap((part) => (part.type === "text" ? [part.text] : []))
						.join("\n"),
				}))
			);
			if (index === 0) {
				return scriptedEvents(
					{
						input: { path: "src/main.ts" },
						toolCallId: "steering-read",
						toolName: "read",
						type: "tool-call",
					},
					{ type: "finish" }
				);
			}
			return scriptedEvents(
				{
					delta: "The parent handled the steering.",
					type: "text-delta",
				},
				{ type: "finish" }
			);
		}
	);
	const statefulAgent = createStatefulAgent({
		runtime: createAgentRuntime({ providerCollection }),
	});
	const pendingSteering = createAgentTurnMessage(
		"user",
		"Finish the queued correction first.",
		toSessionMessageId("queued-steering")
	);
	const runningTurn = consume(statefulAgent.run(buildTurn([tool])));

	try {
		await toolStarted.promise;
		statefulAgent.steer(pendingSteering);

		releaseTool.resolve();
		await runningTurn;
		expect(executionInputs).toEqual([{ path: "src/main.ts" }]);
		expect(observedPrompts[1]?.map(({ role }) => role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
		]);
		expect(observedPrompts[1]?.at(-1)?.text).toBe(
			"Finish the queued correction first."
		);
		expect(requests).toHaveLength(2);
	} finally {
		releaseTool.resolve();
		await statefulAgent.shutdown();
	}
});

test("aborting a Stateful Agent drops queued steering before the next Model Step", async () => {
	const toolStarted = Promise.withResolvers<void>();
	const releaseTool = Promise.withResolvers<void>();
	const tool: ResolvedTool = {
		definition: readDefinition,
		execute: async () => {
			toolStarted.resolve();
			await releaseTool.promise;
			return { output: { content: "source text" }, type: "success" };
		},
	};
	const { providerCollection, requests } = scriptedProvider(
		(_request, index) =>
			index === 0
				? scriptedEvents(
						{
							input: { path: "src/main.ts" },
							toolCallId: "interrupted-read",
							toolName: "read",
							type: "tool-call",
						},
						{ type: "finish" }
					)
				: scriptedEvents(
						{ delta: "The new user turn completed.", type: "text-delta" },
						{ type: "finish" }
					)
	);
	const statefulAgent = createStatefulAgent({
		runtime: createAgentRuntime({ providerCollection }),
	});
	const interruptedTurn = buildTurn([tool]);
	const firstUser = interruptedTurn.input.messages[0];
	if (firstUser === undefined) {
		throw new Error("The interrupted turn has no user message.");
	}
	const steering = createAgentTurnMessage(
		"user",
		"The steering queued before interruption.",
		toSessionMessageId("interrupted-steering")
	);
	const runningTurn = consume(statefulAgent.run(interruptedTurn));

	try {
		await toolStarted.promise;
		statefulAgent.steer(steering);
		statefulAgent.abort();
		releaseTool.resolve();
		await runningTurn;

		expect(requests).toHaveLength(1);
		const nextTurn = {
			...buildTurn(),
			id: toAgentTurnId("turn-after-report-interrupt"),
			input: {
				messages: [
					firstUser,
					createAgentTurnMessage(
						"user",
						"Handle new work.",
						toSessionMessageId("post-interrupt-prompt")
					),
				],
			},
		};
		await consume(statefulAgent.run(nextTurn));

		expect(requests).toHaveLength(2);
		const steeringParts = requests[1]?.messages
			.flatMap(({ content }) => content)
			.filter(
				(part) =>
					part.type === "text" &&
					part.text === "The steering queued before interruption."
			);
		expect(steeringParts).toHaveLength(0);
	} finally {
		releaseTool.resolve();
		await statefulAgent.shutdown();
	}
});

test("invalid model tool input fails visibly without executing the tool", async () => {
	let executed = false;
	const tool: ResolvedTool = {
		definition: readDefinition,
		execute: async () => {
			executed = true;
			return { output: "unexpected", type: "success" };
		},
	};
	const { providerCollection, requests } = scriptedProvider(
		(_request, index) =>
			index === 0
				? scriptedEvents(
						{
							input: { path: 42 },
							toolCallId: "call-invalid",
							toolName: "read",
							type: "tool-call",
						},
						{ type: "finish" }
					)
				: scriptedEvents(
						{ delta: "I need a valid path.", type: "text-delta" },
						{ type: "finish" }
					)
	);
	const events = await consume(
		createAgentRuntime({ providerCollection }).run(buildTurn([tool]))
	);
	const outcome = events.find(({ type }) => type === "tool-call-finished");

	expect(executed).toBe(false);
	expect(outcome).toMatchObject({
		outcome: { errorText: "Tool call input was invalid.", type: "failure" },
	});
	expect(requests[1]?.messages.at(-1)?.content).toEqual([
		{
			errorText: "Tool call input was invalid.",
			toolCallId: "call-invalid",
			toolName: "read",
			type: "tool-failure",
		},
	]);
});

test("cancellation during a model step emits cancellation rather than completion", async () => {
	const pending = Promise.withResolvers<void>();
	const controller = new AbortController();
	const { providerCollection } = scriptedProvider(() => ({
		async *[Symbol.asyncIterator]() {
			await pending.promise;
			yield { type: "finish" };
		},
	}));
	const iterator = createAgentRuntime({ providerCollection })
		.run(buildTurn(), { signal: controller.signal })
		[Symbol.asyncIterator]();

	expect((await iterator.next()).value?.type).toBe("agent-turn-started");
	expect((await iterator.next()).value?.type).toBe("model-step-started");
	controller.abort(new DOMException("cancelled", "AbortError"));
	pending.resolve();
	const terminal = (await iterator.next()).value;

	expect(terminal).toMatchObject({ type: "agent-turn-cancelled" });
});

test("tool-armed turns continue past twenty model steps until the model completes", async () => {
	let executions = 0;
	const tool: ResolvedTool = {
		definition: readDefinition,
		execute: async () => {
			executions += 1;
			return { output: "source text", type: "success" };
		},
	};
	const { providerCollection, requests } = scriptedProvider(
		(_request, index) =>
			index < 25
				? scriptedEvents(
						{
							input: { path: `src/file-${index}.ts` },
							toolCallId: `call-${index}`,
							toolName: "read",
							type: "tool-call",
						},
						{ type: "finish" }
					)
				: scriptedEvents(
						{ delta: "Finished all files.", type: "text-delta" },
						{ type: "finish" }
					)
	);

	const events = await consume(
		createAgentRuntime({ providerCollection }).run(buildTurn([tool]))
	);

	expect(requests).toHaveLength(26);
	expect(executions).toBe(25);
	expect(
		events.filter(({ type }) => type === "model-step-finished")
	).toHaveLength(26);
	expect(events).toContainEqual(
		expect.objectContaining({
			delta: "Finished all files.",
			type: "text-delta",
		})
	);
	expect(events.at(-1)?.type).toBe("agent-turn-completed");
});

test("runtime deadlines fail the turn with the deadline disposition", async () => {
	const pending = Promise.withResolvers<void>();
	const { providerCollection } = scriptedProvider(
		(_request, _index, signal) => ({
			async *[Symbol.asyncIterator]() {
				if (signal === undefined) {
					await pending.promise;
				} else {
					const aborted = Promise.withResolvers<void>();
					signal.addEventListener("abort", () => aborted.resolve(), {
						once: true,
					});
					await Promise.race([pending.promise, aborted.promise]);
					if (signal.aborted) {
						throw signal.reason ?? new DOMException("Aborted", "AbortError");
					}
				}
				yield { type: "finish" };
			},
		})
	);

	const events = await consume(
		createAgentRuntime({ providerCollection }).run(buildTurn(), {
			deadlineMs: 10,
		})
	);
	pending.resolve();

	expect(events.at(-1)).toMatchObject({
		failure: { code: "deadline-exceeded", source: "runtime" },
		type: "agent-turn-failed",
	});
});

test("refuses every Tool Call in a batch that includes an exclusive submit_result", async () => {
	const executions: string[] = [];
	const submitResultTool: ResolvedTool = {
		definition: {
			...readDefinition,
			exclusiveInBatch: true,
			name: "submit_result",
		},
		execute: async () => {
			executions.push("submit_result");
			return { output: "unexpected", type: "success" };
		},
	};
	const readTool: ResolvedTool = {
		definition: readDefinition,
		execute: async () => {
			executions.push("read");
			return { output: "unexpected", type: "success" };
		},
	};
	const { providerCollection } = scriptedProvider((_request, index) =>
		index === 0
			? scriptedEvents(
					{
						input: { path: "final report" },
						toolCallId: "call-submit-result",
						toolName: "submit_result",
						type: "tool-call",
					},
					{
						input: { path: "src/main.ts" },
						toolCallId: "call-read",
						toolName: "read",
						type: "tool-call",
					},
					{ type: "finish" }
				)
			: scriptedEvents(
					{ delta: "No batch side effect ran.", type: "text-delta" },
					{ type: "finish" }
				)
	);
	const events = await consume(
		createAgentRuntime({ providerCollection }).run(
			buildTurn([submitResultTool, readTool])
		)
	);
	const outcomes = events.filter(
		(event) => event.type === "tool-call-finished"
	);

	expect(executions).toEqual([]);
	expect(outcomes).toMatchObject([
		{
			outcome: {
				errorText:
					"submit_result must be the only Tool Call in this Model Step; no Tool Calls in the batch ran.",
				type: "failure",
			},
			toolCallId: "call-submit-result",
		},
		{
			outcome: {
				errorText:
					"submit_result must be the only Tool Call in this Model Step; no Tool Calls in the batch ran.",
				type: "failure",
			},
			toolCallId: "call-read",
		},
	]);
	expect(events.at(-1)?.type).toBe("agent-turn-completed");
});

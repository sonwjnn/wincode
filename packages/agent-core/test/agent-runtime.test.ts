import { expect, test } from "bun:test";
import {
	type AgentTurn,
	type AgentTurnEvent,
	agentIdSchema,
	createAgentRuntime,
	createAgentTurnMessage,
	type ResolvedTool,
	type ToolCallId,
	type ToolDefinition,
	toAgentTurnId,
	toSessionMessageId,
} from "@wincode/agent-core";
import type {
	ModelClient,
	ModelStepRequest,
	ModelStreamPart,
} from "@wincode/ai/model-client";
import { createModelTarget } from "@wincode/ai/model-target";
import { supportedChatModelIdSchema } from "@wincode/ai/models";
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
	model: createModelTarget(
		{
			modelId: supportedChatModelIdSchema.parse("gpt-5.6-luna"),
			providerId: "openai",
		},
		{ kind: "api-key", apiKey: "test-key" }
	),
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

const scriptedClient = (
	script: (
		request: ModelStepRequest,
		index: number
	) => AsyncIterable<ModelStreamPart>
): { client: ModelClient; requests: ModelStepRequest[] } => {
	const requests: ModelStepRequest[] = [];
	return {
		client: {
			stream(request) {
				requests.push(request);
				return script(request, requests.length - 1);
			},
		},
		requests,
	};
};

const scriptedParts = (
	...parts: ModelStreamPart[]
): AsyncIterable<ModelStreamPart> => ({
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
	const { client } = scriptedClient(() =>
		scriptedParts(
			{ delta: "Hello", type: "text-delta" },
			{ delta: " world", type: "text-delta" },
			{
				type: "finish",
				usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
			}
		)
	);
	const events = await consume(
		createAgentRuntime({ modelClient: client }).run(buildTurn())
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
	const { client, requests } = scriptedClient((_request, index) =>
		index === 0
			? scriptedParts(
					{
						input: { path: "src/main.ts" },
						toolCallId: "call-read",
						toolName: "read",
						type: "tool-call",
					},
					{ type: "finish", usage: { inputTokens: 10, outputTokens: 4 } }
				)
			: scriptedParts(
					{ delta: "Found it.", type: "text-delta" },
					{ type: "finish", usage: { inputTokens: 14, outputTokens: 3 } }
				)
	);
	const steering = createAgentTurnMessage(
		"user",
		"Focus on the error path.",
		toSessionMessageId("steering-message")
	);
	const events = await consume(
		createAgentRuntime({ modelClient: client }).run(buildTurn([tool]), {
			takeSteeringMessages: () => [steering],
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

test("invalid model tool input fails visibly without executing the tool", async () => {
	let executed = false;
	const tool: ResolvedTool = {
		definition: readDefinition,
		execute: async () => {
			executed = true;
			return { output: "unexpected", type: "success" };
		},
	};
	const { client, requests } = scriptedClient((_request, index) =>
		index === 0
			? scriptedParts(
					{
						input: { path: 42 },
						toolCallId: "call-invalid",
						toolName: "read",
						type: "tool-call",
					},
					{ type: "finish" }
				)
			: scriptedParts(
					{ delta: "I need a valid path.", type: "text-delta" },
					{ type: "finish" }
				)
	);
	const events = await consume(
		createAgentRuntime({ modelClient: client }).run(buildTurn([tool]))
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
	const { client } = scriptedClient(() => ({
		async *[Symbol.asyncIterator]() {
			await pending.promise;
			yield { type: "finish" };
		},
	}));
	const iterator = createAgentRuntime({ modelClient: client })
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
	const { client, requests } = scriptedClient((_request, index) =>
		index < 25
			? scriptedParts(
					{
						input: { path: `src/file-${index}.ts` },
						toolCallId: `call-${index}`,
						toolName: "read",
						type: "tool-call",
					},
					{ type: "finish" }
				)
			: scriptedParts(
					{ delta: "Finished all files.", type: "text-delta" },
					{ type: "finish" }
				)
	);

	const events = await consume(
		createAgentRuntime({ modelClient: client }).run(buildTurn([tool]))
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
	const { client } = scriptedClient(() => ({
		async *[Symbol.asyncIterator]() {
			await pending.promise;
			yield { type: "finish" };
		},
	}));

	const events = await consume(
		createAgentRuntime({ modelClient: client }).run(buildTurn(), {
			deadlineMs: 10,
		})
	);
	pending.resolve();

	expect(events.at(-1)).toMatchObject({
		failure: { code: "deadline-exceeded", source: "runtime" },
		type: "agent-turn-failed",
	});
});

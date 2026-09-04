import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime, AgentTurnEvent } from "@wincode/agent-core";
import type { CodingAgentUIMessage, ResolvedAgentRuntime } from "@wincode/ai";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { UIMessageChunk } from "ai";
import type { MutableRefObject } from "react";
import type { Connections } from "@/modules/connections";
import type { McpCatalogSnapshot } from "@/modules/mcp";
import type { ToolGate } from "@/modules/tool-gate/tool-gate";
import { createLocalChatTransport } from "./local-chat-transport";
import type { RuntimeFactory } from "./runtime-turn";

const selection: ChatModelSelection = {
	modelId: "gpt-5.4-mini",
	providerId: "openai",
};

const connections = {
	authorize: async () => ({ kind: "api-key", apiKey: "test-key" }),
	connect: async () => undefined,
	listProviders: async () => [],
} as unknown as Connections;

const userMessage = (text: string): CodingAgentUIMessage =>
	({
		id: "msg-user",
		parts: [{ text, type: "text" }],
		role: "user",
	}) as CodingAgentUIMessage;

const emptyManifestSnapshot = {
	agent: "build",
	id: "snapshot-1",
	manifest: [],
	tools: new Map(),
} as unknown as McpCatalogSnapshot;

const runtimeEvents = (
	text: string,
	usage?: { inputTokens: number; outputTokens: number }
): AgentTurnEvent[] => [
	{
		agentId: "build",
		sequence: 0,
		startedAt: 1,
		turnId: "turn-1",
		type: "agent-turn-started",
	},
	{
		modelId: "gpt-5.4-mini",
		sequence: 1,
		stepId: "step-1",
		turnId: "turn-1",
		type: "model-step-started",
	},
	{ delta: text, sequence: 2, turnId: "turn-1", type: "text-delta" },
	{
		sequence: 3,
		stepId: "step-1",
		turnId: "turn-1",
		type: "model-step-finished",
		usage,
	},
	{
		finishedAt: 4,
		sequence: 4,
		turnId: "turn-1",
		type: "agent-turn-completed",
		usage,
	},
];

const fakeRuntime = (events: AgentTurnEvent[]): AgentRuntime => ({
	run: (turn) => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield { ...event, turnId: turn.id };
			}
		},
	}),
});

const consumeChunks = async (
	stream: ReadableStream<UIMessageChunk>
): Promise<string> => {
	let text = "";
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (value.type === "text-delta") {
			text += value.delta;
		}
	}
	return text;
};

describe("createLocalChatTransport runtime routing", () => {
	test("routes an eligible text-only send through the Agent Runtime", async () => {
		const createStream = mock(async () => {
			throw new Error("legacy stream must not be used");
		});
		const createRuntime: RuntimeFactory = () =>
			fakeRuntime(
				runtimeEvents("hi there", { inputTokens: 2, outputTokens: 1 })
			);
		const resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined> =
			{ current: { instructions: "Answer plainly.", visibleCodingTools: [] } };
		const modelRef: MutableRefObject<ChatModelSelection> = {
			current: selection,
		};
		const variantRef: MutableRefObject<undefined> = { current: undefined };

		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			modelRef,
			variantRef,
			connections as Connections,
			createStream,
			emptyManifestSnapshot,
			undefined,
			"build",
			createRuntime
		);

		const stream = await transport.sendMessages({
			abortSignal: new AbortController().signal,
			chatId: "session-1",
			messageId: "msg-user",
			messages: [userMessage("hello")],
			trigger: "submit-message",
		});
		const text = await consumeChunks(stream);

		expect(text).toBe("hi there");
		expect(createStream).not.toHaveBeenCalled();
	});
	test("uses a new Agent Turn identity when retrying after a lost stream", async () => {
		const turnIds: string[] = [];
		let attempt = 0;
		const createRuntime: RuntimeFactory = () => ({
			run: (turn) => {
				turnIds.push(turn.id);
				attempt += 1;
				const events =
					attempt === 1
						? [
								{
									agentId: "build",
									sequence: 0,
									startedAt: 1,
									turnId: turn.id,
									type: "agent-turn-started" as const,
								},
							]
						: runtimeEvents("retry");
				return fakeRuntime(events).run(turn);
			},
		});
		const resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined> =
			{ current: { instructions: "Answer plainly.", visibleCodingTools: [] } };
		const modelRef: MutableRefObject<ChatModelSelection> = {
			current: selection,
		};
		const variantRef: MutableRefObject<undefined> = { current: undefined };
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			modelRef,
			variantRef,
			connections as Connections,
			undefined,
			emptyManifestSnapshot,
			undefined,
			"build",
			createRuntime
		);
		const interruptedAssistant = {
			id: "msg-assistant",
			metadata: { interrupted: true },
			parts: [{ text: "partial", type: "text" }],
			role: "assistant",
		} as unknown as CodingAgentUIMessage;
		const attempts: CodingAgentUIMessage[][] = [
			[userMessage("retry")],
			[userMessage("retry"), interruptedAssistant],
		];

		for (const messages of attempts) {
			const stream = await transport.sendMessages({
				abortSignal: new AbortController().signal,
				chatId: "session-1",
				messageId: "msg-user",
				messages,
				trigger: "submit-message",
			});
			await consumeChunks(stream);
		}

		expect(turnIds).toHaveLength(2);
		expect(turnIds[0]).not.toBe(turnIds[1]);
	});

	test("commits one Conversation Record checkpoint for an eligible completed send", async () => {
		const createStream = mock(async () => {
			throw new Error("legacy stream must not be used");
		});
		const createRuntime: RuntimeFactory = () =>
			fakeRuntime(
				runtimeEvents("hi there", { inputTokens: 2, outputTokens: 1 })
			);
		const resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined> =
			{ current: { instructions: "Answer plainly.", visibleCodingTools: [] } };
		const modelRef: MutableRefObject<ChatModelSelection> = {
			current: selection,
		};
		const variantRef: MutableRefObject<undefined> = { current: undefined };
		const committed: unknown[] = [];
		const commitCheckpoint = async (record: unknown) => {
			committed.push(record);
		};

		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			modelRef,
			variantRef,
			connections as Connections,
			createStream,
			emptyManifestSnapshot,
			undefined,
			"build",
			createRuntime,
			commitCheckpoint
		);

		const stream = await transport.sendMessages({
			abortSignal: new AbortController().signal,
			chatId: "session-1",
			messageId: "msg-user",
			messages: [userMessage("hello")],
			trigger: "submit-message",
		});
		await consumeChunks(stream);

		expect(committed).toHaveLength(1);
		expect(committed[0]).toMatchObject({
			agentId: "build",
			model: { modelId: "gpt-5.4-mini", providerId: "openai" },
			outcome: {
				finishedAt: 4,
				kind: "completed",
				usage: { inputTokens: 2, outputTokens: 1 },
			},
			version: 1,
		});
		const record = committed[0] as {
			messages?: Array<{
				id?: string;
				parts?: Array<{ text?: string }>;
				role?: string;
			}>;
		};
		expect(record.messages?.map((message) => message.parts?.[0]?.text)).toEqual(
			["hello", "hi there"]
		);
	});

	test("keeps the legacy agent stream for tool-armed sends without a gate", async () => {
		const createStream = mock(async () => {
			throw new Error("not reached");
		});
		const createRuntime: RuntimeFactory = () =>
			fakeRuntime(runtimeEvents("unexpected"));
		const resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined> =
			{ current: { instructions: "Build it.", visibleCodingTools: ["read"] } };
		const modelRef: MutableRefObject<ChatModelSelection> = {
			current: selection,
		};
		const variantRef: MutableRefObject<undefined> = { current: undefined };

		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			modelRef,
			variantRef,
			connections as Connections,
			createStream,
			emptyManifestSnapshot,
			undefined,
			"build",
			createRuntime
		);

		// The legacy branch would build the coding agent and call createStream;
		// with createStream stubbed to throw we prove eligibility short-circuits
		// tool-armed sends into the legacy path before any runtime call.
		await expect(
			transport.sendMessages({
				abortSignal: new AbortController().signal,
				chatId: "session-1",
				messageId: "msg-user",
				messages: [userMessage("read the file")],
				trigger: "submit-message",
			})
		).rejects.toThrow("not reached");
	});

	test("routes a read-armed gated send through the Agent Runtime", async () => {
		const gate: ToolGate = {
			gate: async () => ({ kind: "allow" }),
		};
		const createStream = mock(async () => {
			throw new Error("legacy stream must not be used");
		});
		const createRuntime: RuntimeFactory = () =>
			fakeRuntime(
				runtimeEvents("found it", { inputTokens: 2, outputTokens: 1 })
			);
		const resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined> =
			{ current: { instructions: "Read it.", visibleCodingTools: ["read"] } };
		const modelRef: MutableRefObject<ChatModelSelection> = {
			current: selection,
		};
		const variantRef: MutableRefObject<undefined> = { current: undefined };

		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			modelRef,
			variantRef,
			connections as Connections,
			createStream,
			emptyManifestSnapshot,
			undefined,
			"build",
			createRuntime,
			undefined,
			undefined,
			{ gate }
		);

		const stream = await transport.sendMessages({
			abortSignal: new AbortController().signal,
			chatId: "session-1",
			messageId: "msg-user",
			messages: [userMessage("read the file")],
			trigger: "submit-message",
		});
		const text = await consumeChunks(stream);

		expect(text).toBe("found it");
		expect(createStream).not.toHaveBeenCalled();
	});
});

import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime, AgentTurnEvent } from "@wincode/agent-core";
import type { CodingAgentUIMessage, ResolvedAgentRuntime } from "@wincode/ai";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { UIMessageChunk } from "ai";
import type { Connections } from "@/modules/connections";
import type { McpCatalogSnapshot } from "@/modules/mcp";
import { createLocalChatTransport } from "./local-chat-transport";
import type { TextOnlyRuntimeFactory } from "./text-only-turn";

type MutableRefObject<T> = { current: T };

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
	run: () => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
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

describe("createLocalChatTransport text-only runtime routing", () => {
	test("routes an eligible text-only send through the Agent Runtime", async () => {
		const createStream = mock(async () => {
			throw new Error("legacy stream must not be used");
		});
		const createRuntime: TextOnlyRuntimeFactory = () =>
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

	test("keeps the legacy agent stream for tool-armed sends", async () => {
		const createStream = mock(async () => {
			throw new Error("not reached");
		});
		const createRuntime: TextOnlyRuntimeFactory = () =>
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
});

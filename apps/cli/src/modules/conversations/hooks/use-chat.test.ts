import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import type { handleCodingAgentToolCall } from "@wincode/ai/client";
import type { ChatAddToolOutputFunction } from "ai";
import type { McpCatalogSnapshot, McpContextValue } from "@/modules/mcp";
import { prepareSendChatRequestBody } from "../api/chat-request";
import {
	createChatMessageParts,
	createChatToolCallHandler,
	finalizeAssistantMessageMetadata,
	findCurrentTurnAssistantIndex,
	findCurrentTurnInterruptTargetIndex,
	getContinuationChatParams,
	notifyHostedCompletion,
} from "./use-chat";

const selection = {
	modelId: "gemini-2.5-flash",
	providerId: "wincode",
} as const;

const legacyModel = "gemini-3.5-flash";

const userMessage = {
	id: "user-1",
	metadata: { mode: "plan", model: legacyModel },
	parts: [{ text: "hello", type: "text" }],
	role: "user",
} as unknown as CodingAgentUIMessage;

const assistantMessage = {
	id: "assistant-1",
	metadata: { mode: "plan", model: selection },
	parts: [
		{
			input: { path: "README.md" },
			output: { content: "ok", path: "README.md" },
			state: "output-available",
			toolCallId: "call-1",
			type: "tool-read",
		},
	],
	role: "assistant",
} as unknown as CodingAgentUIMessage;

describe("prepareSendChatRequestBody", () => {
	test("normalizes legacy model metadata", () => {
		expect(prepareSendChatRequestBody("session-1", [userMessage])).toEqual({
			messages: [userMessage],
			mode: "plan",
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("keeps canonical selection metadata", () => {
		expect(
			prepareSendChatRequestBody("session-1", [userMessage, assistantMessage])
		).toEqual({
			messages: [userMessage, assistantMessage],
			mode: "plan",
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("uses fallback metadata when no messages include metadata", () => {
		const nextMessage = {
			id: "user-2",
			parts: [{ text: "continue", type: "text" }],
			role: "user",
		} as unknown as CodingAgentUIMessage;

		expect(
			prepareSendChatRequestBody("session-1", [nextMessage], {
				mode: "build",
				model: selection,
			})
		).toEqual({
			messages: [nextMessage],
			mode: "build",
			model: "gemini-2.5-flash",
			persist: false,
			sendReasoning: true,
		});
	});

	test("throws when no message can be sent", () => {
		expect(() => prepareSendChatRequestBody("session-1", [])).toThrow(
			"No message to send"
		);
	});
});

describe("useChat helpers", () => {
	test("preserves file parts in optimistic and sent part order", () => {
		const mention = {
			data: { path: "src/app.ts" },
			type: "data-fileMention",
		} as unknown as CodingAgentUIMessage["parts"][number];
		const file = {
			mediaType: "text/plain",
			type: "file",
			url: "file:///tmp/input.txt",
		} as const;

		expect(createChatMessageParts("inspect", [mention], [file])).toEqual([
			{ text: "inspect", type: "text" },
			mention,
			file,
		]);
	});

	test("does not interrupt an assistant from the previous turn", () => {
		const optimisticUserMessage = {
			id: "user-2",
			parts: [{ text: "next", type: "text" }],
			role: "user",
		} as CodingAgentUIMessage;

		expect(
			findCurrentTurnAssistantIndex([
				userMessage,
				assistantMessage,
				optimisticUserMessage,
			])
		).toBe(-1);
		expect(
			findCurrentTurnInterruptTargetIndex([
				userMessage,
				assistantMessage,
				optimisticUserMessage,
			])
		).toBe(2);
	});

	test("finds the assistant in the current turn", () => {
		expect(
			findCurrentTurnInterruptTargetIndex([
				userMessage,
				assistantMessage,
				{
					id: "user-2",
					parts: [{ text: "next", type: "text" }],
					role: "user",
				} as CodingAgentUIMessage,
				{
					id: "assistant-2",
					parts: [],
					role: "assistant",
				} as CodingAgentUIMessage,
			])
		).toBe(3);
	});

	test("seeds continuation variant and retains assistant variant metadata", () => {
		expect(getContinuationChatParams("plan", selection, "high")).toEqual({
			mode: "plan",
			model: selection,
			variant: "high",
		});

		expect(
			finalizeAssistantMessageMetadata(
				{
					id: "assistant-2",
					parts: [],
					role: "assistant",
				} as CodingAgentUIMessage,
				{
					interrupted: false,
					mode: "plan",
					model: selection,
					variant: "high",
				}
			)
		).toMatchObject({
			metadata: { mode: "plan", model: selection, variant: "high" },
		});
	});

	test("keeps existing assistant variant metadata when continuing", () => {
		expect(
			finalizeAssistantMessageMetadata(
				{
					id: "assistant-3",
					metadata: { model: selection, variant: "low" },
					parts: [],
					role: "assistant",
				} as CodingAgentUIMessage,
				{
					interrupted: true,
					mode: "plan",
					model: selection,
					variant: "high",
				}
			)
		).toMatchObject({
			metadata: { interrupted: true, model: selection, variant: "low" },
		});
	});

	test("refreshes billing only after hosted completion", () => {
		let refreshCount = 0;
		const refresh = () => {
			refreshCount += 1;
		};

		notifyHostedCompletion(selection, refresh);
		notifyHostedCompletion(
			{ modelId: "gpt-5.5", providerId: "openai" },
			refresh
		);

		expect(refreshCount).toBe(1);
	});
});

describe("createChatToolCallHandler", () => {
	const addToolOutput = mock(() => undefined);
	const addToolOutputRef = {
		current:
			addToolOutput as ChatAddToolOutputFunction<CodingAgentUIMessage> | null,
	};
	const modeRef = { current: "build" as const };
	const mcpSnapshotRef = { current: null as McpCatalogSnapshot | null };
	const handleDynamicToolCall = mock(() => undefined);
	const mcp = {
		handleDynamicToolCall,
	} as Pick<McpContextValue, "handleDynamicToolCall">;
	const staticToolCallHandler = mock(() => undefined);

	const makeHandler = () =>
		createChatToolCallHandler({
			addToolOutputRef,
			handleCodingAgentToolCall: (() =>
				staticToolCallHandler) as typeof handleCodingAgentToolCall,
			mcp,
			mcpSnapshotRef,
			modeRef,
		});

	const call = (toolCall: Record<string, unknown>) =>
		makeHandler()({ toolCall } as never);

	afterEach(() => {
		handleDynamicToolCall.mockClear();
		staticToolCallHandler.mockClear();
	});

	test("routes dynamic tool calls to handleDynamicToolCall with the active snapshot", () => {
		const snapshot = { id: "snap-1" } as McpCatalogSnapshot;
		mcpSnapshotRef.current = snapshot;

		call({
			dynamic: true,
			input: { text: "hello" },
			toolCallId: "call-1",
			toolName: "mcp_demo_echo",
		});

		expect(handleDynamicToolCall).toHaveBeenCalledWith(
			snapshot,
			expect.objectContaining({ toolName: "mcp_demo_echo" }),
			addToolOutput
		);
		expect(staticToolCallHandler).not.toHaveBeenCalled();
	});

	test("routes static tool calls to handleCodingAgentToolCall", () => {
		call({
			input: { path: "src/app.ts" },
			toolCallId: "call-2",
			toolName: "read",
		});

		expect(staticToolCallHandler).toHaveBeenCalled();
		expect(handleDynamicToolCall).not.toHaveBeenCalled();
	});

	test("handles a missing or stale snapshot ref without crashing", () => {
		mcpSnapshotRef.current = null;
		call({
			dynamic: true,
			toolCallId: "call-3",
			toolName: "mcp_demo_echo",
		});
		expect(handleDynamicToolCall).toHaveBeenCalledWith(
			null,
			expect.objectContaining({ toolName: "mcp_demo_echo" }),
			addToolOutput
		);

		const stale = { id: "snap-stale" } as McpCatalogSnapshot;
		mcpSnapshotRef.current = stale;
		call({
			dynamic: true,
			toolCallId: "call-4",
			toolName: "mcp_demo_echo",
		});
		expect(handleDynamicToolCall).toHaveBeenCalledWith(
			stale,
			expect.objectContaining({ toolName: "mcp_demo_echo" }),
			addToolOutput
		);
	});

	test("returns early when addToolOutput is not yet available", () => {
		addToolOutputRef.current = null;

		call({
			dynamic: true,
			toolCallId: "call-5",
			toolName: "mcp_demo_echo",
		});

		expect(handleDynamicToolCall).not.toHaveBeenCalled();
		expect(staticToolCallHandler).not.toHaveBeenCalled();
		addToolOutputRef.current = addToolOutput;
	});
});

import { describe, expect, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";

const {
	groupMessagesByConversationTurn,
	resolveConversationTurnFooterMessages,
	resolveTurnMetadataSignature,
} = await import("./chat-turns");

const makeUserMessage = (
	id: string,
	text: string,
	metadata?: CodingAgentUIMessage["metadata"]
): CodingAgentUIMessage => ({
	id,
	metadata,
	parts: [{ text, type: "text" }],
	role: "user",
});

const makeAssistantMessage = (
	id: string,
	text: string,
	metadata?: CodingAgentUIMessage["metadata"]
): CodingAgentUIMessage => ({
	id,
	metadata,
	parts: [{ text, type: "text" }],
	role: "assistant",
});

describe("groupMessagesByConversationTurn", () => {
	test("groups one user message with following assistant messages until next user", () => {
		const turns = groupMessagesByConversationTurn([
			makeUserMessage("user-1", "hello"),
			makeAssistantMessage("assistant-1", "hi"),
			makeAssistantMessage("assistant-2", "more"),
			makeUserMessage("user-2", "next"),
		]);

		expect(
			turns.map((turn) => turn.messages.map((message) => message.id))
		).toEqual([["user-1", "assistant-1", "assistant-2"], ["user-2"]]);
	});

	test("keeps leading assistant messages together when no user starts the stream", () => {
		const turns = groupMessagesByConversationTurn([
			makeAssistantMessage("assistant-1", "opening"),
			makeAssistantMessage("assistant-2", "follow-up"),
		]);

		expect(
			turns.map((turn) => turn.messages.map((message) => message.id))
		).toEqual([["assistant-1", "assistant-2"]]);
	});
});

describe("resolveConversationTurnFooterMessages", () => {
	test("renders optimistic metadata from the latest user message", () => {
		const turns = groupMessagesByConversationTurn([
			makeUserMessage("user-1", "hello", {
				mode: "build",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			}),
		]);
		const footers = resolveConversationTurnFooterMessages(turns);

		expect(footers.get("user-1")?.id).toBe("user-1");
	});

	test("renders one footer for consecutive turns with matching metadata", () => {
		const turns = groupMessagesByConversationTurn([
			makeUserMessage("user-1", "hello"),
			makeAssistantMessage("assistant-1", "first", {
				mode: "build",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				responseTimeMs: 431,
			}),
			makeUserMessage("user-2", "next"),
			makeAssistantMessage("assistant-2", "second", {
				mode: "build",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
				responseTimeMs: 219,
			}),
		]);
		const footers = resolveConversationTurnFooterMessages(turns);

		expect([...footers.values()].map((message) => message.id)).toEqual([
			"assistant-2",
		]);
	});

	test("creates a footer when mode, provider, model, or interruption changes", () => {
		const turns = groupMessagesByConversationTurn([
			makeUserMessage("user-1", "one"),
			makeAssistantMessage("assistant-1", "one", {
				mode: "build",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			}),
			makeUserMessage("user-2", "two"),
			makeAssistantMessage("assistant-2", "two", {
				mode: "plan",
				model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			}),
			makeUserMessage("user-3", "three"),
			makeAssistantMessage("assistant-3", "three", {
				mode: "plan",
				model: { modelId: "gpt-5.5", providerId: "openai" },
			}),
			makeUserMessage("user-4", "four"),
			makeAssistantMessage("assistant-4", "four", {
				interrupted: true,
				mode: "plan",
				model: { modelId: "gpt-5.5", providerId: "openai" },
			}),
		]);
		const footers = resolveConversationTurnFooterMessages(turns);

		expect([...footers.values()].map((message) => message.id)).toEqual([
			"assistant-1",
			"assistant-2",
			"assistant-3",
			"assistant-4",
		]);
	});

	test("treats metadata signature as stable across response-time updates", () => {
		const first = makeAssistantMessage("assistant-1", "one", {
			mode: "build",
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			variant: "high",
			responseTimeMs: 100,
		});
		const second = makeAssistantMessage("assistant-2", "two", {
			mode: "build",
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			variant: "high",
			responseTimeMs: 250,
		});

		expect(resolveTurnMetadataSignature(first)).not.toBeNull();
		expect(resolveTurnMetadataSignature(first)).toBe(
			resolveTurnMetadataSignature(second)
		);
	});
});

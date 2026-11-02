import { expect, test } from "bun:test";
import { findContinuationContextMessages } from "@/modules/sessions/continuation-context";
import type { SessionMessage } from "@/modules/sessions/message";
import { sessionMessageId, toolCallId } from "../support/identifiers";

const userMessage: SessionMessage = {
	id: sessionMessageId("fork-context-user"),
	parts: [{ text: "The source Agent Turn is complete.", type: "text" }],
	role: "user",
};
const terminalAssistantMessage: SessionMessage = {
	id: sessionMessageId("fork-context-assistant"),
	parts: [{ text: "The source Agent Turn completed.", type: "text" }],
	role: "assistant",
};

test("generic continuation still rejects an ordinary terminal assistant checkpoint", () => {
	const result = findContinuationContextMessages([
		userMessage,
		terminalAssistantMessage,
	]);

	expect(result).toMatchObject({
		kind: "rejected",
		reason:
			"The Agent Session can only continue from a user message or completed Tool Call.",
	});
});

test("fork continuation accepts only the exact terminal assistant checkpoint", () => {
	const result = findContinuationContextMessages(
		[userMessage, terminalAssistantMessage],
		{ terminalAssistantMessageId: terminalAssistantMessage.id }
	);

	expect(result).toMatchObject({
		anchor: userMessage,
		kind: "ready",
		lastMessage: terminalAssistantMessage,
	});
	expect(
		findContinuationContextMessages([userMessage, terminalAssistantMessage], {
			terminalAssistantMessageId: sessionMessageId("other-checkpoint"),
		}).kind
	).toBe("rejected");
});

test("fork continuation cannot bypass incomplete Tool Call rejection", () => {
	const pendingToolCall: SessionMessage = {
		id: sessionMessageId("fork-context-pending-tool"),
		parts: [
			{
				input: { path: "secret.txt" },
				state: "input-available",
				toolCallId: toolCallId("fork-context-tool-call"),
				type: "tool-read",
			},
		],
		role: "assistant",
	};

	expect(
		findContinuationContextMessages([userMessage, pendingToolCall], {
			terminalAssistantMessageId: pendingToolCall.id,
		})
	).toMatchObject({
		kind: "rejected",
		reason: "Incomplete Tool Calls cannot be continued.",
	});
});

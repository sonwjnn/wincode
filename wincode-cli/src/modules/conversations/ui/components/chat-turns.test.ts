import { expect, test } from "bun:test";
import type {
	ConversationMessage,
	ConversationMessageTerminalOutcome,
} from "@/modules/conversations/message";
import { prepareRetryMessages } from "../../hooks/use-chat";
import {
	groupMessagesByConversationTurn,
	resolveRetryMessageId,
} from "./chat-turns";

const user = (id: string): ConversationMessage => ({
	id,
	parts: [{ text: id, type: "text" }],
	role: "user",
});

const assistant = (id: string, interrupted = false): ConversationMessage => ({
	id,
	metadata: interrupted ? { interrupted: true } : undefined,
	parts: [{ text: id, type: "text" }],
	role: "assistant",
});

const terminalAssistant = (
	id: string,
	terminalOutcome: ConversationMessageTerminalOutcome
): ConversationMessage => ({
	id,
	metadata: { terminalOutcome },
	parts: [{ text: id, type: "text" }],
	role: "assistant",
});

const completedTool = (): ConversationMessage => ({
	id: "tool",
	parts: [
		{
			input: { command: "rm -rf build" },
			output: { exitCode: 0 },
			state: "output-available",
			toolCallId: "call-1",
			type: "tool-shell",
		},
	],
	role: "assistant",
});

test("offers retry for a persisted failed assistant outcome", () => {
	expect(
		resolveRetryMessageId([
			user("user-1"),
			terminalAssistant("assistant-1", "failed"),
		])
	).toBe("user-1");
});

test("offers retry for an older unanswered user after a later completed turn", () => {
	expect(
		resolveRetryMessageId([
			user("user-1"),
			user("user-2"),
			assistant("assistant-2"),
		])
	).toBe("user-1");
});
test("offers retry for an accepted user row with no assistant outcome", () => {
	expect(resolveRetryMessageId([user("user-1")])).toBe("user-1");
});

test("offers retry for an interrupted assistant without duplicating the user", () => {
	const messages = [user("user-1"), assistant("assistant-1", true)];

	expect(resolveRetryMessageId(messages)).toBe("user-1");
});

test("suppresses retry after a later successful assistant outcome", () => {
	expect(
		resolveRetryMessageId([
			user("user-1"),
			assistant("interrupted-1", true),
			assistant("assistant-2"),
		])
	).toBeUndefined();
});

test("does not offer retry after a completed Tool Call", () => {
	expect(
		resolveRetryMessageId([
			user("user-1"),
			completedTool(),
			assistant("a-1", true),
		])
	).toBeUndefined();
});

test("does not offer retry after a terminal assistant outcome", () => {
	expect(
		resolveRetryMessageId([user("user-1"), assistant("assistant-1")])
	).toBe(undefined);
});

test("prepares retry context without failed output or duplicate user content", () => {
	const result = prepareRetryMessages(
		[
			user("user-1"),
			assistant("assistant-1"),
			user("user-2"),
			assistant("failed-2", true),
		],
		"user-2"
	);

	expect(result).toEqual({
		kind: "ready",
		messages: [user("user-1"), assistant("assistant-1"), user("user-2")],
	});
});

test("excludes persisted failed outcomes from later retry context", () => {
	const failedAssistant: ConversationMessage = {
		id: "failed-1",
		metadata: { terminalOutcome: "failed" },
		parts: [{ text: "safe failure", type: "text" }],
		role: "assistant",
	};
	const result = prepareRetryMessages(
		[user("user-1"), failedAssistant, user("user-2")],
		"user-2"
	);

	expect(result).toEqual({
		kind: "ready",
		messages: [user("user-1"), user("user-2")],
	});
});

test("keeps ordinary user, tool, and assistant rows in one rendered turn", () => {
	const turns = groupMessagesByConversationTurn([
		user("user-1"),
		completedTool(),
		assistant("assistant-1"),
		user("user-2"),
	]);
	expect(
		turns.map((turn) => turn.messages.map((message) => message.id))
	).toEqual([["user-1", "tool", "assistant-1"], ["user-2"]]);
});
test("attaches a retried result to its logical user turn", () => {
	const retryResult: ConversationMessage = {
		...assistant("assistant-retry"),
		metadata: { sourceUserMessageId: "user-1" },
	};
	const turns = groupMessagesByConversationTurn([
		user("user-1"),
		user("user-2"),
		assistant("assistant-2"),
		retryResult,
	]);

	expect(
		turns.map((turn) => turn.messages.map((message) => message.id))
	).toEqual([
		["user-1", "assistant-retry"],
		["user-2", "assistant-2"],
	]);
});
test("suppresses retry after a successful older retry result", () => {
	const retryResult: ConversationMessage = {
		...assistant("assistant-retry"),
		metadata: { sourceUserMessageId: "user-1" },
	};

	expect(
		resolveRetryMessageId([
			user("user-1"),
			user("user-2"),
			assistant("assistant-2"),
			retryResult,
		])
	).toBeUndefined();
});
test("keeps a later user's retry state independent from an older retry result", () => {
	const retryResult: ConversationMessage = {
		...assistant("assistant-retry"),
		metadata: { sourceUserMessageId: "user-1" },
	};

	expect(
		resolveRetryMessageId([
			user("user-1"),
			user("user-2"),
			terminalAssistant("failed-2", "failed"),
			retryResult,
		])
	).toBe("user-2");
});

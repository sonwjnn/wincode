import { expect, test } from "bun:test";
import { prepareRetryMessages } from "@/modules/sessions/engine/submission";
import type {
	SessionMessage,
	SessionMessageTerminalOutcome,
} from "@/modules/sessions/message";
import {
	groupMessagesBySessionTurn,
	resolveRetryMessageId,
	resolveSessionTurnFooterMessages,
} from "@/modules/sessions/ui/components/chat-turns";
import {
	agentId,
	agentTurnId,
	modelId,
	sessionMessageId,
	toolCallId,
} from "../support/identifiers";

const user = (id: string): SessionMessage => ({
	id: sessionMessageId(id),
	parts: [{ text: id, type: "text" }],
	role: "user",
});

const assistant = (id: string, interrupted = false): SessionMessage => ({
	id: sessionMessageId(id),
	metadata: interrupted ? { interrupted: true } : undefined,
	parts: [{ text: id, type: "text" }],
	role: "assistant",
});
const sharedTurnMetadata: NonNullable<SessionMessage["metadata"]> = {
	agent: agentId("build"),
	model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
	variant: "low",
};

const userWithSharedMetadata = (id: string): SessionMessage => ({
	...user(id),
	metadata: sharedTurnMetadata,
});

const assistantWithSharedMetadata = (id: string): SessionMessage => ({
	...assistant(id),
	metadata: sharedTurnMetadata,
});

const terminalAssistant = (
	id: string,
	terminalOutcome: SessionMessageTerminalOutcome
): SessionMessage => ({
	id: sessionMessageId(id),
	metadata: { terminalOutcome },
	parts: [{ text: id, type: "text" }],
	role: "assistant",
});

const completedTool = (): SessionMessage => ({
	id: sessionMessageId("tool"),
	parts: [
		{
			input: { command: "rm -rf build" },
			output: { exitCode: 0 },
			state: "output-available",
			toolCallId: toolCallId("call-1"),
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
	).toBe(sessionMessageId("user-1"));
});

test("offers retry for an older unanswered user after a later completed turn", () => {
	expect(
		resolveRetryMessageId([
			user("user-1"),
			user("user-2"),
			assistant("assistant-2"),
		])
	).toBe(sessionMessageId("user-1"));
});
test("offers retry for an accepted user row with no assistant outcome", () => {
	expect(resolveRetryMessageId([user("user-1")])).toBe(
		sessionMessageId("user-1")
	);
});

test("offers retry for an interrupted assistant without duplicating the user", () => {
	const messages = [user("user-1"), assistant("assistant-1", true)];

	expect(resolveRetryMessageId(messages)).toBe(sessionMessageId("user-1"));
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
		sessionMessageId("user-2")
	);

	expect(result).toEqual({
		kind: "ready",
		messages: [user("user-1"), assistant("assistant-1"), user("user-2")],
	});
});

test("excludes persisted failed outcomes from later retry context", () => {
	const failedAssistant: SessionMessage = {
		id: sessionMessageId("failed-1"),
		metadata: { terminalOutcome: "failed" },
		parts: [{ text: "safe failure", type: "text" }],
		role: "assistant",
	};
	const result = prepareRetryMessages(
		[user("user-1"), failedAssistant, user("user-2")],
		sessionMessageId("user-2")
	);

	expect(result).toEqual({
		kind: "ready",
		messages: [user("user-1"), user("user-2")],
	});
});

test("keeps ordinary user, tool, and assistant rows in one rendered turn", () => {
	const turns = groupMessagesBySessionTurn([
		user("user-1"),
		completedTool(),
		assistant("assistant-1"),
		user("user-2"),
	]);
	expect(
		turns.map((turn) => turn.messages.map((message) => message.id))
	).toEqual([
		[
			sessionMessageId("user-1"),
			sessionMessageId("tool"),
			sessionMessageId("assistant-1"),
		],
		[sessionMessageId("user-2")],
	]);
});
test("attaches a retried result to its logical user turn", () => {
	const retryResult: SessionMessage = {
		...assistant("assistant-retry"),
		metadata: { sourceUserMessageId: sessionMessageId("user-1") },
	};
	const turns = groupMessagesBySessionTurn([
		user("user-1"),
		user("user-2"),
		assistant("assistant-2"),
		retryResult,
	]);

	expect(
		turns.map((turn) => turn.messages.map((message) => message.id))
	).toEqual([
		[sessionMessageId("user-1"), sessionMessageId("assistant-retry")],
		[sessionMessageId("user-2"), sessionMessageId("assistant-2")],
	]);
});
test("suppresses retry after a successful older retry result", () => {
	const retryResult: SessionMessage = {
		...assistant("assistant-retry"),
		metadata: { sourceUserMessageId: sessionMessageId("user-1") },
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
	const retryResult: SessionMessage = {
		...assistant("assistant-retry"),
		metadata: { sourceUserMessageId: sessionMessageId("user-1") },
	};

	expect(
		resolveRetryMessageId([
			user("user-1"),
			user("user-2"),
			terminalAssistant("failed-2", "failed"),
			retryResult,
		])
	).toBe(sessionMessageId("user-2"));
});

test("groups matching metadata while the next turn runs and after completion", () => {
	const messages = [
		userWithSharedMetadata("user-1"),
		assistantWithSharedMetadata("assistant-1"),
		userWithSharedMetadata("user-2"),
	];
	const turns = groupMessagesBySessionTurn(messages);
	const footers = resolveSessionTurnFooterMessages(turns);

	expect(
		[...footers.entries()].map(([turnId, message]) => [turnId, message.id])
	).toEqual([["user-2", "user-2"]]);

	const completedTurns = groupMessagesBySessionTurn([
		...messages,
		assistantWithSharedMetadata("assistant-2"),
	]);
	const completedFooters = resolveSessionTurnFooterMessages(completedTurns);

	expect(
		[...completedFooters.entries()].map(([turnId, message]) => [
			turnId,
			message.id,
		])
	).toEqual([["user-2", "assistant-2"]]);
});

test("keeps a Steering Message inside the turn it joined", () => {
	const steering: SessionMessage = {
		...user("user-steer"),
		metadata: { joinedTurnId: agentTurnId("turn-1") },
	};
	const turns = groupMessagesBySessionTurn([
		user("user-1"),
		assistant("assistant-1"),
		steering,
		assistant("assistant-2"),
		user("user-2"),
	]);

	// The correction is part of the turn it was delivered into: the transcript
	// reads as the turn the model actually ran, and only the message that
	// opened the next turn starts one.
	expect(
		turns.map((turn) => turn.messages.map((message) => message.id))
	).toEqual([
		[
			sessionMessageId("user-1"),
			sessionMessageId("assistant-1"),
			sessionMessageId("user-steer"),
			sessionMessageId("assistant-2"),
		],
		[sessionMessageId("user-2")],
	]);
});

test("retries the message that opened the turn a Steering Message joined", () => {
	const steering: SessionMessage = {
		...user("user-steer"),
		metadata: { joinedTurnId: agentTurnId("turn-1") },
	};
	const failedAssistant = assistant("assistant-1");
	const messages = [
		user("user-1"),
		steering,
		{ ...failedAssistant, metadata: { terminalOutcome: "failed" as const } },
	];

	// Retry replays the turn from the input that started it, so a joined message
	// is never mistaken for a new attempt's opener, and the correction the user
	// made inside the failed turn stays in the replayed context.
	expect(resolveRetryMessageId(messages)).toBe(sessionMessageId("user-1"));
	const retry = prepareRetryMessages(messages, sessionMessageId("user-1"));
	expect(retry.kind).toBe("ready");
	expect(
		retry.kind === "ready" ? retry.messages.map(({ id }) => id) : []
	).toEqual([sessionMessageId("user-1"), sessionMessageId("user-steer")]);
});

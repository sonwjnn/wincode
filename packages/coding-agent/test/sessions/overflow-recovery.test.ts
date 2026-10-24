import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { createOperationalFailure } from "@wincode/agent-core";
import {
	isContextOverflowFailure,
	prepareOverflowContinuationSource,
	prepareOverflowRecoveryMessages,
} from "@/modules/sessions/compaction/overflow-recovery";
import type { SessionMessage } from "@/modules/sessions/message";
import { sessionMessageId, toolCallId } from "../support/identifiers";

const message = (
	id: string,
	role: SessionMessage["role"],
	text: string,
	metadata?: SessionMessage["metadata"]
): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		metadata,
		parts: [{ text, type: "text" }],
		role,
	});

test("prepares eligible overflow context without the failed assistant turn", () => {
	const messages = [
		message("u1", "user", "earlier"),
		message("a1", "assistant", "earlier answer"),
		message("u2", "user", "retry me"),
		message("a2", "assistant", "partial output", { interrupted: true }),
	];

	expect(
		prepareOverflowRecoveryMessages(messages, sessionMessageId("u2")).map(
			({ id }) => id
		)
	).toEqual([
		sessionMessageId("u1"),
		sessionMessageId("a1"),
		sessionMessageId("u2"),
	]);
});

test("refuses recovery when its original user message is gone", () => {
	expect(() =>
		prepareOverflowRecoveryMessages(
			[message("a1", "assistant", "answer")],
			sessionMessageId("u2")
		)
	).toThrow(
		expect.objectContaining({
			code: "compaction-failed",
			message: expect.stringContaining("original user message"),
		})
	);
});

test("recognizes a provider failure the runtime reported as context overflow", () => {
	// The Agent Runtime turns a provider refusal into an Operational Failure
	// whose message is presentation-safe, so the code — not the text — is what
	// identifies the overflow.
	expect(
		isContextOverflowFailure(
			createOperationalFailure({
				code: "context-overflow",
				retry: "with-changes",
				source: "model",
			})
		)
	).toBe(true);
	expect(
		isContextOverflowFailure(
			createOperationalFailure({
				code: "rate-limited",
				retry: "after-delay",
				source: "model",
			})
		)
	).toBe(false);
	expect(
		isContextOverflowFailure(
			new Error("This model's maximum context length is 128000 tokens.")
		)
	).toBe(true);
	expect(isContextOverflowFailure(new Error("authentication failed"))).toBe(
		false
	);
});

test("continuation source drops the failed row and protects the newest settled batch", () => {
	const messages: SessionMessage[] = [
		fromPartial<SessionMessage>({
			id: sessionMessageId("older-user"),
			parts: [{ text: "older request", type: "text" }],
			role: "user",
		}),
		fromPartial<SessionMessage>({
			id: sessionMessageId("older-assistant"),
			parts: [{ text: "older answer", type: "text" }],
			role: "assistant",
		}),
		fromPartial<SessionMessage>({
			id: sessionMessageId("attempt-user"),
			parts: [{ text: "run the tools", type: "text" }],
			role: "user",
		}),
		fromPartial<SessionMessage>({
			id: sessionMessageId("step-assistant"),
			parts: [
				{
					input: { command: "pwd" },
					output: { output: "/workspace" },
					state: "output-available",
					toolCallId: toolCallId("call-step"),
					type: "tool-shell",
				},
			],
			role: "assistant",
		}),
		fromPartial<SessionMessage>({
			id: sessionMessageId("failed-assistant"),
			metadata: { terminalOutcome: "failed" },
			parts: [{ text: "The prompt exceeds the context window.", type: "text" }],
			role: "assistant",
		}),
	];

	const source = prepareOverflowContinuationSource(messages);

	// The failure row is not durable progress; it must not be summarized or continued from.
	expect(source?.sourceMessages.map(({ id }) => id as string)).toEqual([
		"older-user",
		"older-assistant",
		"attempt-user",
		"step-assistant",
	]);
	// The completed Tool Call and its settled step survive compaction untouched.
	expect(source?.protectedMessageIds.map((id) => id as string)).toEqual([
		"step-assistant",
	]);
});

test("a continuation source is unavailable without a completed tool batch", () => {
	expect(
		prepareOverflowContinuationSource([
			fromPartial<SessionMessage>({
				id: sessionMessageId("user-only"),
				parts: [{ text: "no tools yet", type: "text" }],
				role: "user",
			}),
			fromPartial<SessionMessage>({
				id: sessionMessageId("assistant-text"),
				parts: [{ text: "plain answer", type: "text" }],
				role: "assistant",
			}),
		])
	).toBeNull();
});

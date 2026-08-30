import { expect, mock, test } from "bun:test";
import type { CodingAgentUIMessage } from "@wincode/ai";
import {
	prepareOverflowReplayMessages,
	recoverContextOverflow,
} from "./overflow-recovery";

const message = (
	id: string,
	role: CodingAgentUIMessage["role"],
	text: string,
	metadata?: CodingAgentUIMessage["metadata"]
): CodingAgentUIMessage =>
	({
		id,
		metadata,
		parts: [{ text, type: "text" }],
		role,
	}) as CodingAgentUIMessage;

const compaction = {
	compact: mock(async () => ({
		activeMessages: [
			message("summary", "user", "summary"),
			message("u2", "user", "retry"),
		],
		entry: {} as never,
	})),
	getInFlight: () => null,
	needsCompaction: () => true,
};

const compactionInput = {
	model: { modelId: "gpt-5.4-mini", providerId: "openai" } as const,
	settings: {
		enabled: true,
		keepRecentTokens: 100,
		thresholdTokens: 100,
	} as const,
};

test("prepares overflow replay without the failed assistant turn", () => {
	const messages = [
		message("u1", "user", "earlier"),
		message("a1", "assistant", "earlier answer"),
		message("u2", "user", "retry me"),
		message("a2", "assistant", "partial output", { interrupted: true }),
	];

	expect(
		prepareOverflowReplayMessages(messages, "u2").map(({ id }) => id)
	).toEqual(["u1", "a1", "u2"]);
});

test("replays a context-overflow turn exactly once with its original message id", async () => {
	const replay = mock(async () => undefined);
	const result = await recoverContextOverflow({
		attempt: 0,
		compaction,
		compactionInput,
		conversation: {
			messages: [
				message("u1", "user", "earlier"),
				message("a1", "assistant", "earlier answer"),
				message("u2", "user", "retry me"),
				message("a2", "assistant", "partial output", { interrupted: true }),
			],
			sessionId: "session-1",
		},
		enabled: true,
		error: new Error("context_length_exceeded"),
		originalMessageId: "u2",
		replay,
	});

	expect(result?.activeMessages.map(({ id }) => id)).toEqual(["summary", "u2"]);
	expect(compaction.compact).toHaveBeenCalledWith(
		expect.objectContaining({ trigger: "overflow" })
	);
	expect(replay).toHaveBeenCalledWith({
		activeMessages: result?.activeMessages,
		originalMessageId: "u2",
	});
});

test("preserves non-context provider errors without compacting", async () => {
	const error = new Error("authentication failed");
	await expect(
		recoverContextOverflow({
			attempt: 0,
			compaction,
			compactionInput,
			conversation: {
				messages: [message("u1", "user", "retry")],
				sessionId: "session-non-context",
			},
			enabled: true,
			error,
			originalMessageId: "u1",
			replay: async () => undefined,
		})
	).rejects.toBe(error);
});

test("surfaces compaction failure without replaying the original turn", async () => {
	const failingCompaction = {
		...compaction,
		compact: mock(async () => {
			throw new Error("summary failed");
		}),
	};
	const replay = mock(async () => undefined);

	await expect(
		recoverContextOverflow({
			attempt: 0,
			compaction: failingCompaction,
			compactionInput,
			conversation: {
				messages: [
					message("u1", "user", "earlier"),
					message("a1", "assistant", "answer"),
					message("u2", "user", "retry"),
				],
				sessionId: "session-failure",
			},
			enabled: true,
			error: new Error("context_length_exceeded"),
			originalMessageId: "u2",
			replay,
		})
	).rejects.toMatchObject({ code: "replay-failed" });
	expect(replay).not.toHaveBeenCalled();
});

test("does not replay disabled or already-replayed overflow requests", async () => {
	for (const [enabled, attempt, code] of [
		[false, 0, "disabled"],
		[true, 1, "replay-exhausted"],
	] as const) {
		await expect(
			recoverContextOverflow({
				attempt,
				compaction,
				compactionInput,
				conversation: {
					messages: [message("u1", "user", "retry")],
					sessionId: "session-2",
				},
				enabled,
				error: new Error("context_length_exceeded"),
				originalMessageId: "u1",
				replay: async () => undefined,
			})
		).rejects.toMatchObject({ code });
	}
});

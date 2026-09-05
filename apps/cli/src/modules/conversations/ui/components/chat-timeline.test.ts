import { expect, test } from "bun:test";
import type { ConversationMessage } from "@/modules/conversations/message";
import type { ConversationCompaction } from "../../compaction";
import { buildConversationTimeline } from "./chat-timeline";

const message = (
	id: string,
	role: ConversationMessage["role"]
): ConversationMessage =>
	({ id, parts: [{ text: id, type: "text" }], role }) as ConversationMessage;

const compaction = (
	id: string,
	sequence: number,
	throughMessageUiId: string
): ConversationCompaction => ({
	completedAt: new Date("2026-08-30T00:00:00.000Z"),
	createdAt: new Date("2026-08-30T00:00:00.000Z"),
	firstKeptUiMessageId: "u2",
	id,
	sequence,
	sessionId: "session-1",
	summarizationModel: { modelId: "gpt-5.4-mini", providerId: "openai" },
	summary: { coveredMessageIds: ["u1"], formatVersion: 1, text: id },
	throughMessageUiId,
	tokensAfter: 20,
	tokensBefore: 40,
	trigger: "manual",
});

test("places compaction dividers after their transcript anchor without creating turns", () => {
	const timeline = buildConversationTimeline(
		[
			message("u1", "user"),
			message("a1", "assistant"),
			message("u2", "user"),
			message("a2", "assistant"),
		],
		[compaction("c1", 1, "a1")]
	);

	expect(timeline.map((item) => item.kind)).toEqual([
		"turn",
		"compaction",
		"turn",
	]);
	const firstTurn = timeline[0];
	expect(
		firstTurn?.kind === "turn"
			? firstTurn.turn.messages.map(({ id }) => id)
			: []
	).toEqual(["u1", "a1"]);
});

test("orders repeated dividers by durable sequence and keeps unknown anchors visible", () => {
	const timeline = buildConversationTimeline(
		[message("u1", "user"), message("a1", "assistant")],
		[compaction("c2", 2, "missing"), compaction("c1", 1, "a1")]
	);

	expect(
		timeline
			.filter((item) => item.kind === "compaction")
			.map((item) => item.compaction.id)
	).toEqual(["c1", "c2"]);
});

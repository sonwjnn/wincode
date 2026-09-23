import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { SessionCompaction } from "@/modules/sessions/compaction";
import type { SessionMessage } from "@/modules/sessions/message";
import { buildSessionTimeline } from "@/modules/sessions/ui/components/chat-timeline";
import {
	compactionId,
	modelId,
	sessionId,
	sessionMessageId,
} from "../support/identifiers";

const message = (id: string, role: SessionMessage["role"]): SessionMessage =>
	fromPartial<SessionMessage>({
		id: sessionMessageId(id),
		parts: [{ text: id, type: "text" }],
		role,
	});

const compaction = (
	id: string,
	sequence: number,
	throughMessageUiId: string
): SessionCompaction => ({
	completedAt: new Date("2026-08-30T00:00:00.000Z"),
	createdAt: new Date("2026-08-30T00:00:00.000Z"),
	firstKeptUiMessageId: sessionMessageId("u2"),
	id: compactionId(id),
	sequence,
	sessionId: sessionId("session-1"),
	summarizationModel: {
		modelId: modelId("gpt-5.6-luna"),
		providerId: "openai",
	},
	summary: {
		coveredMessageIds: [sessionMessageId("u1")],
		formatVersion: 1,
		text: id,
	},
	throughMessageUiId: sessionMessageId(throughMessageUiId),
	estimatedTokensAfter: 20,
	tokensBefore: 40,
	trigger: "manual",
});

test("places compaction dividers after their transcript anchor without creating turns", () => {
	const timeline = buildSessionTimeline(
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
	).toEqual([sessionMessageId("u1"), sessionMessageId("a1")]);
});

test("orders repeated dividers by durable sequence and keeps unknown anchors visible", () => {
	const timeline = buildSessionTimeline(
		[message("u1", "user"), message("a1", "assistant")],
		[compaction("c2", 2, "missing"), compaction("c1", 1, "a1")]
	);

	expect(
		timeline
			.filter((item) => item.kind === "compaction")
			.map((item) => item.compaction.id)
	).toEqual([compactionId("c1"), compactionId("c2")]);
});

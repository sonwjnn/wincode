import type { SessionMessage } from "@/modules/sessions/message";
import type { UiNotificationAnchor } from "@/shared/providers/toast/types";
import {
	isCompactionSummaryMessage,
	type SessionCompaction,
} from "../../compaction";
import { groupMessagesBySessionTurn, type SessionTurn } from "./chat-turns";

export type SessionTimelineItem =
	| { kind: "turn"; turn: SessionTurn }
	| { kind: "compaction"; compaction: SessionCompaction };

export type SessionTimelineAnchor = UiNotificationAnchor;

export type SessionTranscriptProjection = Readonly<{
	messages: readonly SessionMessage[];
	turns: readonly SessionTurn[];
	timeline: readonly SessionTimelineItem[];
	notificationAnchor: SessionTimelineAnchor;
}>;

export const buildSessionTranscriptProjection = (
	transcriptMessages: readonly SessionMessage[],
	compactions: readonly SessionCompaction[] = []
): SessionTranscriptProjection => {
	const messages = transcriptMessages.filter(
		(message) => !isCompactionSummaryMessage(message)
	);
	const turns = groupMessagesBySessionTurn([...messages]);
	const turnIdByMessageId = new Map<string, string>();
	for (const turn of turns) {
		for (const message of turn.messages) {
			turnIdByMessageId.set(message.id, turn.id);
		}
	}

	const orderedCompactions = [...compactions].sort(
		(left, right) => left.sequence - right.sequence
	);
	const compactionsByTurnId = new Map<string, SessionCompaction[]>();
	const unmatchedCompactions: SessionCompaction[] = [];
	for (const compaction of orderedCompactions) {
		const turnId = turnIdByMessageId.get(compaction.throughMessageUiId);
		if (turnId === undefined) {
			unmatchedCompactions.push(compaction);
			continue;
		}
		const turnCompactions = compactionsByTurnId.get(turnId) ?? [];
		turnCompactions.push(compaction);
		compactionsByTurnId.set(turnId, turnCompactions);
	}

	const timeline: SessionTimelineItem[] = [];
	for (const turn of turns) {
		timeline.push({ kind: "turn", turn });
		for (const compaction of compactionsByTurnId.get(turn.id) ?? []) {
			timeline.push({ kind: "compaction", compaction });
		}
	}
	for (const compaction of unmatchedCompactions) {
		timeline.push({ kind: "compaction", compaction });
	}

	const lastItem = timeline.at(-1);
	const lastTurnMessage =
		lastItem?.kind === "turn" ? lastItem.turn.messages.at(-1) : undefined;
	const notificationAnchor: SessionTimelineAnchor = {
		messageCount: messages.length,
		timelineItemCount: timeline.length,
		...(lastTurnMessage === undefined
			? {}
			: { afterMessageId: lastTurnMessage.id }),
		...(lastItem?.kind === "compaction"
			? { afterCompactionId: lastItem.compaction.id }
			: {}),
	};

	return { messages, turns, timeline, notificationAnchor };
};

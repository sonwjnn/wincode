import type { SessionMessage } from "@/modules/sessions/message";
import {
	isCompactionSummaryMessage,
	type SessionCompaction,
} from "../../compaction";
import { groupMessagesBySessionTurn, type SessionTurn } from "./chat-turns";

export type SessionTimelineItem =
	| { kind: "turn"; turn: SessionTurn }
	| { kind: "compaction"; compaction: SessionCompaction };

export const buildSessionTimeline = (
	messages: readonly SessionMessage[],
	compactions: readonly SessionCompaction[] = []
): SessionTimelineItem[] => {
	const displayMessages = messages.filter(
		(message) => !isCompactionSummaryMessage(message)
	);
	const turns = groupMessagesBySessionTurn([...displayMessages]);
	const orderedCompactions = [...compactions].sort(
		(left, right) => left.sequence - right.sequence
	);
	const placed = new Set<string>();
	const timeline: SessionTimelineItem[] = [];

	for (const turn of turns) {
		timeline.push({ kind: "turn", turn });
		const turnMessageIds = new Set(turn.messages.map((message) => message.id));
		for (const compaction of orderedCompactions) {
			if (
				!placed.has(compaction.id) &&
				turnMessageIds.has(compaction.throughMessageUiId)
			) {
				timeline.push({ kind: "compaction", compaction });
				placed.add(compaction.id);
			}
		}
	}

	for (const compaction of orderedCompactions) {
		if (!placed.has(compaction.id)) {
			timeline.push({ kind: "compaction", compaction });
		}
	}

	return timeline;
};

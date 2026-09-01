import type { CodingAgentUIMessage } from "@wincode/ai";
import {
	type ConversationCompaction,
	isCompactionSummaryMessage,
} from "../../compaction";
import {
	type ConversationTurn,
	groupMessagesByConversationTurn,
} from "./chat-turns";

export type ConversationTimelineItem =
	| { kind: "turn"; turn: ConversationTurn }
	| { kind: "compaction"; compaction: ConversationCompaction };

export const buildConversationTimeline = (
	messages: readonly CodingAgentUIMessage[],
	compactions: readonly ConversationCompaction[] = []
): ConversationTimelineItem[] => {
	const displayMessages = messages.filter(
		(message) => !isCompactionSummaryMessage(message)
	);
	const turns = groupMessagesByConversationTurn([...displayMessages]);
	const orderedCompactions = [...compactions].sort(
		(left, right) => left.sequence - right.sequence
	);
	const placed = new Set<string>();
	const timeline: ConversationTimelineItem[] = [];

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

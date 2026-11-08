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

export const buildSessionTranscriptTimeline = (
	messages: readonly SessionMessage[],
	compactions: readonly SessionCompaction[] = []
): SessionTimelineItem[] => {
	const newestCompaction = compactions.reduce<SessionCompaction | undefined>(
		(newest, compaction) =>
			newest === undefined || compaction.sequence > newest.sequence
				? compaction
				: newest,
		undefined
	);
	const historicalCompactions = compactions.filter(
		({ id }) => id !== newestCompaction?.id
	);
	const timeline = buildSessionTimeline(messages, historicalCompactions);
	return newestCompaction === undefined
		? timeline
		: [...timeline, { kind: "compaction", compaction: newestCompaction }];
};

export const getSessionTimelineAnchor = (
	messages: readonly SessionMessage[],
	compactions: readonly SessionCompaction[] = []
): SessionTimelineAnchor => {
	const timeline = buildSessionTranscriptTimeline(messages, compactions);
	const messageCount = timeline.reduce(
		(count, item) =>
			item.kind === "turn" ? count + item.turn.messages.length : count,
		0
	);
	const lastItem = timeline.at(-1);
	const lastTurnMessage =
		lastItem?.kind === "turn" ? lastItem.turn.messages.at(-1) : undefined;
	return {
		messageCount,
		timelineItemCount: timeline.length,
		...(lastTurnMessage === undefined
			? {}
			: { afterMessageId: lastTurnMessage.id }),
		...(lastItem?.kind === "compaction"
			? { afterCompactionId: lastItem.compaction.id }
			: {}),
	};
};

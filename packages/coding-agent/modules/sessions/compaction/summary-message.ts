import { type SessionMessageId, toSessionMessageId } from "@wincode/agent-core";
import type { CompactionId } from "@/shared/identifiers";
import type { SessionMessage } from "../message";
import type { CompactionSummary, SessionCompaction } from "./types";

/**
 * The Session Message form of a compaction summary. These helpers are a leaf on
 * purpose: the Session Engine depends on them, so they must not reach React
 * through the compaction module (ADR-0019).
 */
const SUMMARY_MESSAGE_PREFIX = "<wincode-compaction-summary>";
const SUMMARY_MESSAGE_SUFFIX = "</wincode-compaction-summary>";

export const compactionSummaryMessageId = (
	entryId: CompactionId
): SessionMessageId => toSessionMessageId(`compaction:${entryId}`);

export const formatCompactionSummaryMessage = (
	summary: CompactionSummary
): string => {
	const attachmentMetadata = (summary.attachments ?? []).map((attachment) =>
		JSON.stringify({
			attachmentId: attachment.attachmentId,
			available: attachment.available,
			byteLength: attachment.byteLength,
			filename: attachment.filename,
			mediaType: attachment.mediaType,
			payloadOmitted: true,
		})
	);
	return [
		SUMMARY_MESSAGE_PREFIX,
		summary.text,
		...(attachmentMetadata.length > 0
			? ["Attachments:", ...attachmentMetadata]
			: []),
		SUMMARY_MESSAGE_SUFFIX,
	].join("\n");
};

export const createCompactionSummaryMessage = (
	entry: Pick<SessionCompaction, "id" | "summary">
): SessionMessage => ({
	id: compactionSummaryMessageId(entry.id),
	parts: [
		{
			text: formatCompactionSummaryMessage(entry.summary),
			type: "text",
		},
	],
	role: "user",
});

export const isCompactionSummaryMessage = (
	message: Pick<SessionMessage, "id">
): boolean => message.id.startsWith("compaction:");

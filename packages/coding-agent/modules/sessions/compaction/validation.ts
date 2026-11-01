import type { SessionMessageId } from "@wincode/agent-core";
import { SessionCompactionError } from "./error";
import type { SessionCompaction } from "./types";

type CompactionReferences = Pick<
	SessionCompaction,
	"firstKeptUiMessageId" | "id" | "summary" | "throughMessageUiId"
>;

export const assertCompactionMessageReferences = (
	compaction: CompactionReferences,
	availableMessageIds: ReadonlySet<SessionMessageId>
): void => {
	const references = [
		{ id: compaction.firstKeptUiMessageId, label: "message" },
		{ id: compaction.throughMessageUiId, label: "message" },
		...compaction.summary.coveredMessageIds.map((id) => ({
			id,
			label: "covered message",
		})),
	];
	for (const { id, label } of references) {
		if (!availableMessageIds.has(id)) {
			throw new SessionCompactionError(
				"invalid-boundary",
				`Compaction boundary "${compaction.id}" references missing ${label} "${id}".`
			);
		}
	}
};

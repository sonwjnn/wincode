import { rebuildActiveMessages } from "./compaction/compaction";
import type { SessionCompaction } from "./compaction/types";
import {
	filterSessionMessagesForActiveContext,
	type SessionMessage,
} from "./message";

/** Rebuilds the unedited active context, including its compaction summary. */
export const rebuildUneditedSessionContext = (
	transcript: readonly SessionMessage[],
	compactions: readonly SessionCompaction[]
): SessionMessage[] =>
	rebuildActiveMessages(
		filterSessionMessagesForActiveContext(transcript),
		compactions.at(-1) ?? null
	);

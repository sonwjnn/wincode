import type { SessionMessageId, SessionRecord } from "@wincode/agent-core";
import {
	listSessionForkCheckpointAssessments,
	type SessionForkCheckpointAssessment,
} from "../session-fork-checkpoint-validation";

/** Indexes validated and refused Session Record boundaries by their visible message. */
export const indexSessionForkCheckpoints = (
	records: readonly SessionRecord[]
): ReadonlyMap<SessionMessageId, SessionForkCheckpointAssessment> =>
	new Map(
		listSessionForkCheckpointAssessments(records).map((assessment) => [
			assessment.messageId,
			assessment,
		])
	);

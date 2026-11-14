import type { DrizzleSessionStore } from "../../../modules/sessions/storage/drizzle-session-store";
import type { SessionRecords } from "../../../modules/sessions/storage/session-records";
import { successfulSessionWriteOutcome } from "./outcome";

/**
 * A Session Records stub over projection-only storage for tests that exercise
 * one record-writing behavior and cannot run the authoritative JSONL store.
 */
export const recordsFacet = (
	projectionStore: DrizzleSessionStore
): SessionRecords => ({
	appendCompaction: async (input) => {
		const compaction = await projectionStore.appendCompaction(input);
		return {
			compaction,
			writeOutcome: successfulSessionWriteOutcome(
				`compaction-${compaction.id}`,
				compaction.sequence
			),
		};
	},
	appendContextEdit: async () => {
		throw new Error("Context edits require the authoritative JSONL store.");
	},
	commitSessionRecord: async (input) => {
		await projectionStore.commitSessionRecord(input);
		return successfulSessionWriteOutcome(`record-${input.record.id}`);
	},
	...(projectionStore.fileObservationStore === undefined
		? {}
		: { fileObservationStore: projectionStore.fileObservationStore }),
	findSessionRecordBySubmissionId: async () => undefined,
	listSessionRecords: async (sessionId) =>
		await projectionStore.listSessionRecords(sessionId),
	updateSessionSubmission: async (input) => {
		const operationId = input.operationId ?? crypto.randomUUID();
		await projectionStore.updateSessionSubmission({ ...input, operationId });
		return successfulSessionWriteOutcome(operationId);
	},
});

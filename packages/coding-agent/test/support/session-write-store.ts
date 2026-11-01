import { randomUUIDv7 } from "bun";
import type {
	CreateSessionUsageEntryInput,
	SessionProjectionStore,
	SessionStore,
	SessionWriteOutcome,
	UpdateSessionInput,
	UpdateSessionSubmissionInput,
} from "../../modules/sessions/storage/session-store";

export const successfulSessionWriteOutcome = (
	operationId: string,
	sequence = 0
): SessionWriteOutcome => ({
	entryHash: "0".repeat(64),
	kind: "committed",
	operationId,
	projection: "ready",
	sequence,
});

export const failedSessionWriteOutcome = (
	operationId: string,
	code = "session_write_failed",
	message = "The test Session write was not committed."
): SessionWriteOutcome => ({
	error: { code, message },
	kind: "not-committed",
	operationId,
	retryDisposition: "do-not-retry",
});

/** Adapts projection-only storage for unit tests that exercise Session Host behavior. */
export const sessionStoreWithSuccessfulWrites = (
	projectionStore: SessionProjectionStore
): SessionStore => ({
	...projectionStore,
	listSessionCatalog: async () => ({
		issues: [],
		sessions: await projectionStore.listSessions(),
	}),
	listSessionsPage: async () => ({
		readPoint: "test-read-point",
		sessions: [],
	}),
	readSessionHistoryPage: async () => {
		throw new Error("Session history pages are not used by this test store.");
	},
	listRecentModelSelections: async (limit) =>
		await projectionStore.listRecentModelSelections(limit),
	rebuildProjection: (_scope, withMaintenanceGate) =>
		withMaintenanceGate(async () => ({
			generation: 0,
			issues: [],
			rebuiltSessionIds: [],
			skippedSessionIds: [],
		})),
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
	commitSessionRecord: async (input) => {
		await projectionStore.commitSessionRecord(input);
		return successfulSessionWriteOutcome(`record-${input.record.id}`);
	},
	createEmptySession: async (input) => {
		const created = await projectionStore.createEmptySession(input);
		return {
			...created,
			writeOutcome: successfulSessionWriteOutcome(`create-${created.id}`),
		};
	},
	createSession: async (input) => {
		const created = await projectionStore.createSession(input);
		return {
			...created,
			writeOutcome: successfulSessionWriteOutcome(`create-${created.id}`),
		};
	},
	createSessionWithExternalizedMessage: async (input) => {
		const created = await projectionStore.createSession(input);
		return {
			...created,
			message: input.message,
			writeOutcome: successfulSessionWriteOutcome(`create-${created.id}`),
		};
	},
	createSessionUsageEntry: async (input: CreateSessionUsageEntryInput) => ({
		entry: await projectionStore.createSessionUsageEntry(input),
		writeOutcome: successfulSessionWriteOutcome(`usage-${input.id}`),
	}),
	deleteSession: async (sessionId) => {
		await projectionStore.deleteSession(sessionId);
		return successfulSessionWriteOutcome(`delete-${sessionId}`);
	},
	findSessionRecordBySubmissionId: async () => undefined,
	setEditMode: async (sessionId, mode, operationId) => {
		await projectionStore.setEditMode?.(sessionId, mode, operationId);
		return successfulSessionWriteOutcome(operationId ?? randomUUIDv7());
	},
	updateSession: async (sessionId, input: UpdateSessionInput) => {
		const operationId = input.operationId ?? randomUUIDv7();
		await projectionStore.updateSession(sessionId, { ...input, operationId });
		return successfulSessionWriteOutcome(operationId);
	},
	updateSessionSubmission: async (input: UpdateSessionSubmissionInput) => {
		const operationId = input.operationId ?? randomUUIDv7();
		await projectionStore.updateSessionSubmission({ ...input, operationId });
		return successfulSessionWriteOutcome(operationId);
	},
});

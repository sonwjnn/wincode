import { randomUUIDv7 } from "bun";
import type {
	CreateSessionUsageEntryInput,
	SessionProjectionStore,
	SessionStatistics,
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
	appendContextEdit: async () => {
		throw new Error("Context edits require the authoritative JSONL store.");
	},
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
	readSessionHistoryTreePage: async () => {
		throw new Error(
			"Session history tree pages are not used by this test store."
		);
	},
	readSessionHistoryPath: async (sessionId) => {
		const [session, records, compactions, contextEdits] = await Promise.all([
			projectionStore.getSession(sessionId),
			projectionStore.listSessionRecords(sessionId),
			projectionStore.getCompactions(sessionId),
			projectionStore.getSessionContextEdits(sessionId),
		]);
		const entries = records.map((record, index) => {
			const previousRecord = records[index - 1];
			return {
				createdAt: new Date(),
				id: `test-history-entry-${record.id}`,
				kind: "record" as const,
				parentEntryId:
					previousRecord === undefined
						? null
						: `test-history-entry-${previousRecord.id}`,
				record,
				recordId: record.id,
				selectedPath: true,
				sequence: index + 1,
			};
		});
		return {
			activeLeafId: entries.at(-1)?.id ?? null,
			compactions,
			contextEdits,
			entries,
			historyGeneration: 0,
			model: session.model,
			records,
			thinkingLevel: session.thinkingLevel,
		};
	},
	navigateSessionHistory: async (_sessionId, _targetEntryId, operationId) =>
		successfulSessionWriteOutcome(operationId),
	forkSession: async () => {
		throw new Error(
			"Session forking is not used by this projection-only test store."
		);
	},
	forkSessionWithHeldWriter: async () => {
		throw new Error(
			"Session forking is not used by this projection-only test store."
		);
	},
	getSessionForkProvenance: async () => undefined,
	getPluginSessionState: async () => undefined,
	mutatePluginSessionState: async (_sessionId, _pluginId, mutation) => ({
		kind: "written",
		writeOutcome: successfulSessionWriteOutcome(mutation.operationId),
	}),
	getOrCreateSessionForkActionId: async () => {
		throw new Error(
			"Session fork action IDs are not used by this projection-only test store."
		);
	},
	completeSessionForkAction: async () => {
		throw new Error(
			"Session fork action IDs are not used by this projection-only test store."
		);
	},
	getSessionStatistics: async (sessionId, options) => {
		const emptyUsage = {
			byModel: [],
			cacheReadTokens: null,
			cacheWriteTokens: null,
			contributionCount: 0,
			costs: [],
			inputTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			totalTokens: null,
			unknownCostCount: 0,
		} satisfies SessionStatistics["usage"]["actual"];
		return {
			completedToolCallCount: 0,
			recordCount: 0,
			readPoint: options?.readPoint ?? "test-read-point",
			sessionId,
			terminalOutcomeCounts: {
				cancelled: 0,
				completed: 0,
				failed: 0,
				interrupted: 0,
			},
			...(options?.turnId === undefined
				? {}
				: {
						turn: {
							completedToolCallCount: 0,
							recordCount: 0,
							terminalOutcome: { kind: "no-terminal-record" as const },
							turnId: options.turnId,
						},
					}),
			usage: {
				actual: emptyUsage,
				auxiliary: emptyUsage,
				contributions: {
					actual: [],
					auxiliary: [],
					inherited: [],
					selectedPath: [],
				},
				inherited: emptyUsage,
				selectedPath: emptyUsage,
			},
		};
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

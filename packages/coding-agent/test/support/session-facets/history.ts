import { toSessionHistoryEntryId } from "@/shared/identifiers";
import type { DrizzleSessionStore } from "../../../modules/sessions/storage/drizzle-session-store";
import type { SessionHistory } from "../../../modules/sessions/storage/session-history";
import { successfulSessionWriteOutcome } from "./outcome";

/**
 * A Session History stub over projection-only storage for tests that exercise
 * one history read and cannot run the authoritative JSONL store.
 */
export const historyFacet = (
	projectionStore: DrizzleSessionStore
): SessionHistory => ({
	appendPluginSessionHistoryEntry: async (_sessionId, _pluginId, input) => ({
		entryId: toSessionHistoryEntryId("test-plugin-history-entry"),
		writeOutcome: successfulSessionWriteOutcome(input.operationId),
	}),
	getCompactions: async (sessionId) =>
		await projectionStore.getCompactions(sessionId),
	getLatestCompaction: async (sessionId) =>
		await projectionStore.getLatestCompaction(sessionId),
	hasSessionHistoryEntry: async () => false,
	navigateSessionHistory: async (_sessionId, request) =>
		successfulSessionWriteOutcome(request.operationId),
	readPluginSessionHistoryPage: async () => {
		throw new Error("Plugin history pages are not used by this test store.");
	},
	readSessionHistoryPage: async () => {
		throw new Error("Session history pages are not used by this test store.");
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
				id: toSessionHistoryEntryId(`test-history-entry-${record.id}`),
				kind: "record" as const,
				parentEntryId:
					previousRecord === undefined
						? null
						: toSessionHistoryEntryId(
								`test-history-entry-${previousRecord.id}`
							),
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
	readSessionHistoryTreePage: async () => {
		throw new Error(
			"Session history tree pages are not used by this test store."
		);
	},
});

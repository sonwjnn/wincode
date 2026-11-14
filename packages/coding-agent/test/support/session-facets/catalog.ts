import type { DrizzleSessionStore } from "../../../modules/sessions/storage/drizzle-session-store";
import type { SessionCatalog } from "../../../modules/sessions/storage/session-catalog";
import type { SessionStatistics } from "../../../modules/sessions/usage/session-statistics";
import { successfulSessionWriteOutcome } from "./outcome";

/**
 * A Session Catalog stub over projection-only storage for tests that exercise
 * one catalog read and cannot run the authoritative JSONL store.
 */
export const catalogFacet = (
	projectionStore: DrizzleSessionStore
): SessionCatalog => ({
	createSessionUsageEntry: async (input) => ({
		entry: await projectionStore.createSessionUsageEntry(input),
		writeOutcome: successfulSessionWriteOutcome(`usage-${input.id}`),
	}),
	getSession: async (sessionId) => await projectionStore.getSession(sessionId),
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
	listSessionCatalog: async () => ({
		issues: [],
		sessions: await projectionStore.listSessions(),
	}),
	listSessions: async () => await projectionStore.listSessions(),
	listSessionsPage: async () => ({
		readPoint: "test-read-point",
		sessions: [],
	}),
	listSessionUsageEntries: async (sessionId) =>
		await projectionStore.listSessionUsageEntries(sessionId),
});

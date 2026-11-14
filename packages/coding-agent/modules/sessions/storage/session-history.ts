import type { SessionHistoryEntryId, SessionId } from "@/shared/identifiers";
import type { SessionCompaction } from "../compaction/types";
import type {
	SessionHistoryNavigationRequest,
	SessionHistoryPage,
	SessionHistoryPath,
	SessionHistoryTreePage,
	SessionPageOptions,
} from "../session-pagination-types";
import type {
	PluginSessionHistoryAppendInput,
	PluginSessionHistoryAppendResult,
	PluginSessionHistoryPage,
} from "../session-plugin-history";
import type { SessionWriteOutcome } from "../session-write-outcome";

/**
 * One Session's durable history: its records as pages and as a tree, the path
 * currently selected, the compactions that summarised it, and the entries a
 * Plugin appended beside it. Moving the selection is a write and reports the
 * same write outcome every other durable Session write does.
 */
export type SessionHistory = Readonly<{
	/**
	 * Appends a Plugin-owned history entry. It lives here rather than on a
	 * Plugin facet because the one consumer owns this whole history cluster, and
	 * splitting it out would create a single-consumer facet.
	 */
	appendPluginSessionHistoryEntry: (
		sessionId: SessionId,
		pluginId: string,
		input: PluginSessionHistoryAppendInput
	) => Promise<PluginSessionHistoryAppendResult>;
	getCompactions: (sessionId: SessionId) => Promise<SessionCompaction[]>;
	getLatestCompaction: (
		sessionId: SessionId
	) => Promise<SessionCompaction | null>;
	hasSessionHistoryEntry: (
		sessionId: SessionId,
		entryId: SessionHistoryEntryId
	) => Promise<boolean>;
	navigateSessionHistory: (
		sessionId: SessionId,
		request: SessionHistoryNavigationRequest
	) => Promise<SessionWriteOutcome>;
	readPluginSessionHistoryPage: (
		sessionId: SessionId,
		pluginId: string,
		options?: SessionPageOptions
	) => Promise<PluginSessionHistoryPage>;
	readSessionHistoryPage: (
		sessionId: SessionId,
		options?: SessionPageOptions
	) => Promise<SessionHistoryPage>;
	readSessionHistoryPath: (sessionId: SessionId) => Promise<SessionHistoryPath>;
	readSessionHistoryTreePage: (
		sessionId: SessionId,
		options?: SessionPageOptions
	) => Promise<SessionHistoryTreePage>;
}>;

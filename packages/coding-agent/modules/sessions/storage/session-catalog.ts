import type { ModelUsage } from "@wincode/ai";
import type {
	CompactionId,
	SessionId,
	SessionUsageEntryId,
} from "../../../shared/identifiers";
import type { ProviderModelSelection } from "../../providers/provider-model-selection";
import type {
	Session,
	SessionCatalogPage,
	SessionPageOptions,
} from "../session-pagination-types";
import type { SessionWriteOutcome } from "../session-write-outcome";
import type {
	SessionStatistics,
	SessionStatisticsOptions,
} from "../usage/session-statistics";

export type SessionCatalogIssue = Readonly<{
	code: string;
	message: string;
	offset?: number;
	operationId?: string;
	sessionId: SessionId;
	sequence?: number;
}>;

export type SessionCatalogResult = Readonly<{
	issues: SessionCatalogIssue[];
	sessions: Session[];
}>;

/** Durable usage-only accounting that never projects into a Session Record. */
export type SessionUsageEntry = Readonly<{
	compactionId?: CompactionId;
	costUsd: number | null;
	createdAt: Date;
	id: SessionUsageEntryId;
	kind: "cache-warm" | "compaction-summary";
	model: ProviderModelSelection;
	sessionId: SessionId;
	usage: ModelUsage;
}>;

export type CreateSessionUsageEntryInput = Omit<
	SessionUsageEntry,
	"createdAt"
> & {
	createdAt?: Date;
};

/**
 * The Sessions one workspace holds, as metadata: which Sessions exist, what
 * they are called, what they cost, and which models were picked recently.
 * Reading a Session's contents or moving through its history belongs to
 * `SessionHistory`, not here.
 */
export type SessionCatalog = Readonly<{
	createSessionUsageEntry: (input: CreateSessionUsageEntryInput) => Promise<{
		entry?: SessionUsageEntry;
		writeOutcome: SessionWriteOutcome;
	}>;
	getSession: (sessionId: SessionId) => Promise<Session>;
	getSessionStatistics: (
		sessionId: SessionId,
		options?: SessionStatisticsOptions
	) => Promise<SessionStatistics>;
	listRecentModelSelections: (
		limit: number
	) => Promise<ProviderModelSelection[]>;
	listSessionCatalog: () => Promise<SessionCatalogResult>;
	listSessions: () => Promise<Session[]>;
	listSessionsPage: (
		options?: SessionPageOptions
	) => Promise<SessionCatalogPage>;
	listSessionUsageEntries: (
		sessionId: SessionId
	) => Promise<SessionUsageEntry[]>;
}>;

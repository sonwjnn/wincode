import type {
	AgentId,
	AgentTurnId,
	SessionMessageId,
	SessionRecord,
	SessionRecordId,
	SessionRecordOutcome,
	SessionSubmissionStatus,
	SubmissionId,
} from "@wincode/agent-core";
import type { ModelUsage, ThinkingLevel } from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { EditMode, FileObservationStore } from "@/modules/tools";
import type {
	CompactionId,
	SessionHistoryEntryId,
	SessionId,
	SessionUsageEntryId,
} from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type {
	Session,
	SessionCatalogPage,
	SessionHistoryNavigationRequest,
	SessionHistoryPage,
	SessionHistoryPath,
	SessionHistoryTreePage,
	SessionPageOptions,
} from "../session-pagination-types";
import type {
	SessionWriteOutcome,
	SessionWriteReceipt,
} from "../session-write-outcome";
import type {
	SessionStatistics,
	SessionStatisticsOptions,
	SessionUsageContribution,
} from "../usage/session-statistics";
import type {
	AttachmentExternalizationLease,
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	SessionAttachmentStore,
} from "./attachment-store";

export type {
	Session,
	SessionCatalogPage,
	SessionHistoryPage,
	SessionHistoryPath,
	SessionHistoryTreeEntry,
	SessionHistoryTreePage,
	SessionPageOptions,
} from "../session-pagination-types";
export type {
	SessionStatistics,
	SessionStatisticsOptions,
} from "../usage/session-statistics";

import type { SessionContextEdit } from "../context-edits";
import type { SessionBundleImportResult } from "../session-bundle-contract";
import type {
	PluginSessionHistoryAppendInput,
	PluginSessionHistoryAppendResult,
	PluginSessionHistoryPage,
} from "../session-plugin-history";
import type {
	PluginSessionStateMutation,
	PluginSessionStateMutationResult,
	PluginSessionStateRecord,
} from "../session-plugin-state";
import type {
	PreparedSessionBundleExport,
	SessionBundleImportFileSystem,
} from "./session-bundle";
import type {
	SessionWriterLock,
	SessionWriterLockOptions,
} from "./session-writer-lock";

export type {
	SessionWriteFailure,
	SessionWriteOutcome,
	SessionWriteReceipt,
} from "../session-write-outcome";

export type PromptHistoryEntry = {
	fileTokens?: Array<{ start: number; token: string }>;
	files: SessionFilePart[];
	text: string;
	pastedText?: Array<{ start: number; token: string; text: string }>;
};
export type SessionRecordStorageOutcome = SessionRecordOutcome;

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

export type SessionProjectionRebuildScope =
	| Readonly<{ kind: "all" }>
	| Readonly<{ kind: "session"; sessionId: SessionId }>;

export type SessionProjectionRebuildResult = Readonly<{
	generation: number;
	issues: SessionCatalogIssue[];
	rebuiltSessionIds: SessionId[];
	skippedSessionIds: SessionId[];
}>;

export type SessionForkCheckpoint = Readonly<{
	recordId: SessionRecordId;
}>;

export type SessionForkResult = Readonly<{
	created: boolean;
	id: SessionId;
	checkpoint: Readonly<{
		recordId: SessionRecordId;
		sequence: number;
		turnId: AgentTurnId;
	}>;
	writeOutcome: SessionWriteOutcome;
}>;

export type SessionForkSubmissionProvenance = Readonly<{
	failure?: string;
	sourceMessageId: SessionMessageId;
	sourceRecordId: SessionRecordId;
	sourceSubmissionId: SubmissionId;
	status: SessionSubmissionStatus;
	targetMessageId: SessionMessageId;
	targetRecordId: SessionRecordId;
	targetSubmissionId: SubmissionId;
}>;

export type SessionForkProvenance = Readonly<{
	sourceAvailability?: "available" | "unavailable";
	inheritedCompactionIds: readonly CompactionId[];
	inheritedRecordIds: readonly SessionRecordId[];
	inheritedSubmissions: readonly SessionForkSubmissionProvenance[];
	inheritedUsage: readonly SessionUsageContribution[];
	sourceLogId: string;
	sourceMessageId: SessionMessageId;
	sourceRecordId: SessionRecordId;
	sourceSequence: number;
	sourceSessionId: SessionId;
	sourceTurnId: AgentTurnId;
	targetMessageId: SessionMessageId;
	targetRecordId: SessionRecordId;
	targetTurnId: AgentTurnId;
}>;

export type SessionDeletionOutcome =
	| SessionWriteOutcome
	| Readonly<{
			code: "session_cleanup_pending";
			kind: "cleanup-pending";
			message: string;
			operationId: string;
			receipt: SessionWriteReceipt;
	  }>;

export type SessionProjectionMaintenanceGate = <Result>(
	operation: () => Promise<Result>
) => Promise<Result>;

export type CreateSessionInput = {
	createdAt?: Date;
	id?: SessionId;
	initialRecord?: SessionRecord;
	agent: AgentId;
	message: SessionMessage;
	model: ProviderModelSelection;
	turnId: AgentTurnId;
	thinkingLevel?: ThinkingLevel;
};
export type CreateEmptySessionInput = Readonly<{
	createdAt?: Date;
	id?: SessionId;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;
export type UpdateSessionInput = {
	operationId?: string;
	pinned?: boolean;
	title?: string;
};

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
 * One semantic checkpoint: a Wincode Session Record for one accepted user
 * message, completed Tool Call, or terminal assistant outcome. The commit is
 * atomic at the SessionStore boundary; its tagged outcome distinguishes a
 * refused write from an indeterminate publication.
 */
export type CommitSessionRecordInput = {
	sessionModel?: ProviderModelSelection;
	sessionThinkingLevel?: ThinkingLevel;
	externalizationLease?: AttachmentExternalizationLease;
	record: SessionRecord;
	sessionId: SessionId;
};

export type UpdateSessionSubmissionInput = {
	operationId?: string;
	failure?: string;
	messageId: SessionMessageId;
	recordId: SessionRecordId;
	sessionId: SessionId;
	status: SessionSubmissionStatus;
	submissionId: SubmissionId;
};

export type SessionSubmissionRecordReceipt = Readonly<{
	message: SessionRecord["messages"][number];
	recordId: SessionRecordId;
	writeOutcome: SessionWriteReceipt;
}>;

export type SessionProjectionStore = {
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompaction>;
	createSession: (
		input: CreateSessionInput
	) => Promise<{ created?: boolean; id: SessionId }>;
	createSessionUsageEntry: (
		input: CreateSessionUsageEntryInput
	) => Promise<SessionUsageEntry>;
	listSessionUsageEntries: (
		sessionId: SessionId
	) => Promise<SessionUsageEntry[]>;
	getSessionContextEdits: (
		sessionId: SessionId
	) => Promise<SessionContextEdit[]>;
	createEmptySession: (
		input: CreateEmptySessionInput
	) => Promise<{ created?: boolean; id: SessionId }>;
	deleteSession: (sessionId: SessionId) => Promise<void>;
	resetSessionData: () => Promise<void>;
	getCompactions: (sessionId: SessionId) => Promise<SessionCompaction[]>;
	getLatestCompaction: (
		sessionId: SessionId
	) => Promise<SessionCompaction | null>;
	getSession: (sessionId: SessionId) => Promise<Session>;
	acquireSessionWriter: (
		sessionId: SessionId,
		options?: SessionWriterLockOptions
	) => Promise<SessionWriterLock>;
	listSessions: () => Promise<Session[]>;
	listRecentModelSelections: (limit: number) => ProviderModelSelection[];
	commitSessionRecord: (input: CommitSessionRecordInput) => Promise<void>;
	listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
	updateSessionSubmission: (
		input: UpdateSessionSubmissionInput
	) => Promise<void>;
	updateSession: (
		sessionId: SessionId,
		data: UpdateSessionInput
	) => Promise<void>;
	getPromptHistory: () => Promise<PromptHistoryEntry[]>;
	recordPrompt: (entry: PromptHistoryEntry) => Promise<void>;
	clearPromptHistory: () => Promise<void>;
	getEditMode?: (sessionId: SessionId) => Promise<EditMode>;
	setEditMode?: (
		sessionId: SessionId,
		mode: EditMode,
		operationId?: string
	) => Promise<void>;
	fileObservationStore?: FileObservationStore;
	attachmentStore?: SessionAttachmentStore;
	withSessionBundleExport?: <Result>(
		sessionId: SessionId,
		operation: (source: PreparedSessionBundleExport) => Promise<Result>,
		options: Readonly<{ existingHostWriter: boolean; signal?: AbortSignal }>
	) => Promise<Result>;
	withSessionBundleImport?: (
		bundlePath: string,
		options: Readonly<{
			fileSystem?: SessionBundleImportFileSystem;
			signal?: AbortSignal;
		}>
	) => Promise<SessionBundleImportResult>;
	isSessionImportActivationPending?: (sessionId: SessionId) => Promise<boolean>;
	isSessionImported?: (sessionId: SessionId) => Promise<boolean>;
	confirmSessionImportActivation?: (sessionId: SessionId) => Promise<void>;
	hydrateAttachments: (
		messages: readonly SessionMessage[],
		options: AttachmentHydrationOptions
	) => Promise<SessionMessage[]>;
	externalizeAttachments: (
		messages: readonly SessionMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	) => Promise<AttachmentExternalizationLease>;
	collectAttachments: (
		safetyWindowMs?: number
	) => Promise<AttachmentMaintenanceReport>;
};

export type SessionCompactionWriteResult = Readonly<{
	compaction?: SessionCompaction;
	writeOutcome: SessionWriteOutcome;
}>;

export type SessionStore = Omit<
	SessionProjectionStore,
	| "appendCompaction"
	| "commitSessionRecord"
	| "createEmptySession"
	| "createSession"
	| "createSessionUsageEntry"
	| "deleteSession"
	| "findSessionRecordBySubmissionId"
	| "listRecentModelSelections"
	| "setEditMode"
	| "updateSession"
	| "updateSessionSubmission"
> & {
	appendContextEdit: (
		sessionId: SessionId,
		edit: SessionContextEdit
	) => Promise<SessionWriteOutcome>;
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompactionWriteResult>;
	commitSessionRecord: (
		input: CommitSessionRecordInput
	) => Promise<SessionWriteOutcome>;
	createEmptySession: (input: CreateEmptySessionInput) => Promise<{
		created?: boolean;
		id: SessionId;
		writeOutcome: SessionWriteOutcome;
	}>;
	createSession: (input: CreateSessionInput) => Promise<{
		created?: boolean;
		id: SessionId;
		writeOutcome: SessionWriteOutcome;
	}>;
	createSessionWithExternalizedMessage: (input: CreateSessionInput) => Promise<{
		created?: boolean;
		id: SessionId;
		message: SessionMessage;
		writeOutcome: SessionWriteOutcome;
	}>;
	createSessionUsageEntry: (input: CreateSessionUsageEntryInput) => Promise<{
		entry?: SessionUsageEntry;
		writeOutcome: SessionWriteOutcome;
	}>;
	deleteSession: (sessionId: SessionId) => Promise<SessionDeletionOutcome>;
	findSessionRecordBySubmissionId: (
		sessionId: SessionId,
		submissionId: SubmissionId
	) => Promise<SessionSubmissionRecordReceipt | undefined>;
	listSessionCatalog: () => Promise<SessionCatalogResult>;
	listSessionsPage: (
		options?: SessionPageOptions
	) => Promise<SessionCatalogPage>;
	readSessionHistoryPage: (
		sessionId: SessionId,
		options?: SessionPageOptions
	) => Promise<SessionHistoryPage>;
	readSessionHistoryTreePage: (
		sessionId: SessionId,
		options?: SessionPageOptions
	) => Promise<SessionHistoryTreePage>;
	readSessionHistoryPath: (sessionId: SessionId) => Promise<SessionHistoryPath>;
	readPluginSessionHistoryPage: (
		sessionId: SessionId,
		pluginId: string,
		options?: SessionPageOptions
	) => Promise<PluginSessionHistoryPage>;
	appendPluginSessionHistoryEntry: (
		sessionId: SessionId,
		pluginId: string,
		input: PluginSessionHistoryAppendInput
	) => Promise<PluginSessionHistoryAppendResult>;
	hasSessionHistoryEntry: (
		sessionId: SessionId,
		entryId: SessionHistoryEntryId
	) => Promise<boolean>;
	navigateSessionHistory: (
		sessionId: SessionId,
		request: SessionHistoryNavigationRequest
	) => Promise<SessionWriteOutcome>;
	getSessionStatistics: (
		sessionId: SessionId,
		options?: SessionStatisticsOptions
	) => Promise<SessionStatistics>;
	getSessionForkProvenance: (
		sessionId: SessionId
	) => Promise<SessionForkProvenance | undefined>;
	/** Keeps one UI action's retry ID durable until that action is acknowledged. */
	getOrCreateSessionForkActionId: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint
	) => Promise<string>;
	/** Clears the acknowledged UI action so a later deliberate fork gets a new ID. */
	completeSessionForkAction: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<void>;
	forkSession: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<SessionForkResult>;
	/** Runs a fork through an idle Host that already holds the source writer. */
	forkSessionWithHeldWriter: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<SessionForkResult>;
	listRecentModelSelections: (
		limit: number
	) => Promise<ProviderModelSelection[]>;
	rebuildProjection: (
		scope: SessionProjectionRebuildScope,
		withMaintenanceGate: SessionProjectionMaintenanceGate
	) => Promise<SessionProjectionRebuildResult>;
	setEditMode?: (
		sessionId: SessionId,
		mode: EditMode,
		operationId?: string
	) => Promise<SessionWriteOutcome>;
	updateSession: (
		sessionId: SessionId,
		data: UpdateSessionInput
	) => Promise<SessionWriteOutcome>;
	updateSessionSubmission: (
		input: UpdateSessionSubmissionInput
	) => Promise<SessionWriteOutcome>;
	getPluginSessionState: (
		sessionId: SessionId,
		pluginId: string,
		key: string
	) => Promise<PluginSessionStateRecord | undefined>;
	mutatePluginSessionState: (
		sessionId: SessionId,
		pluginId: string,
		mutation: PluginSessionStateMutation
	) => Promise<PluginSessionStateMutationResult>;
};
export const UNTITLED_SESSION_TITLE = "Untitled Session";

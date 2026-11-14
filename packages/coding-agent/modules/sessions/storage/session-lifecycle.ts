import type {
	AgentId,
	AgentTurnId,
	SessionMessageId,
	SessionRecord,
	SessionRecordId,
	SessionSubmissionStatus,
	SubmissionId,
} from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { SessionMessage } from "@/modules/sessions/message";
import type { EditMode } from "@/modules/tools";
import type { CompactionId, SessionId } from "@/shared/identifiers";
import type {
	SessionBundleExportScope,
	SessionBundleImportResult,
} from "../session-bundle-contract";
import type {
	SessionWriteOutcome,
	SessionWriteReceipt,
} from "../session-write-outcome";
import type { SessionUsageContribution } from "../usage/session-statistics";
import type {
	PreparedSessionBundleExport,
	SessionBundleImportFileSystem,
} from "./session-bundle";
import type { SessionCatalogIssue } from "./session-catalog";
import type {
	SessionWriterLock,
	SessionWriterLockOptions,
} from "./session-writer-lock";

export type SessionProjectionRebuildScope =
	| Readonly<{ kind: "all" }>
	| Readonly<{ kind: "session"; sessionId: SessionId }>;

export type SessionProjectionRebuildResult = Readonly<{
	generation: number;
	issues: SessionCatalogIssue[];
	rebuiltSessionIds: SessionId[];
	skippedSessionIds: SessionId[];
}>;

export type SessionProjectionMaintenanceGate = <Result>(
	operation: () => Promise<Result>
) => Promise<Result>;

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

export const UNTITLED_SESSION_TITLE = "Untitled Session";

/**
 * The existence and identity of a Session: creating it, editing the one
 * `session` row that names it, deleting it, forking it, carrying it in and out
 * as a bundle, and rebuilding the projection every facet reads.
 *
 * This facet is also the only place a Session Writer is acquired. Record writes
 * happen under that writer, but the writer is not passed to `SessionRecords`:
 * the single-writer invariant is a Host-layer admission rule, not a type here.
 */
export type SessionLifecycle = Readonly<{
	acquireSessionWriter: (
		sessionId: SessionId,
		options?: SessionWriterLockOptions
	) => Promise<SessionWriterLock>;
	/** Clears the acknowledged UI action so a later deliberate fork gets a new ID. */
	completeSessionForkAction: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint,
		operationId: string
	) => Promise<void>;
	confirmSessionImportActivation: (sessionId: SessionId) => Promise<void>;
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
	deleteSession: (sessionId: SessionId) => Promise<SessionDeletionOutcome>;
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
	getSessionForkProvenance: (
		sessionId: SessionId
	) => Promise<SessionForkProvenance | undefined>;
	/** Reads the `editMode` column beside `setEditMode`; it is not projected into `getSession`. */
	getEditMode: (sessionId: SessionId) => Promise<EditMode>;
	/** Keeps one UI action's retry ID durable until that action is acknowledged. */
	getOrCreateSessionForkActionId: (
		sourceSessionId: SessionId,
		checkpoint: SessionForkCheckpoint
	) => Promise<string>;
	isSessionImportActivationPending: (sessionId: SessionId) => Promise<boolean>;
	isSessionImported: (sessionId: SessionId) => Promise<boolean>;
	rebuildProjection: (
		scope: SessionProjectionRebuildScope,
		withMaintenanceGate: SessionProjectionMaintenanceGate
	) => Promise<SessionProjectionRebuildResult>;
	resetSessionData: () => Promise<void>;
	/** Writes the `editMode` column beside `updateSession`; both edit the `session` row. */
	setEditMode: (
		sessionId: SessionId,
		mode: EditMode,
		operationId?: string
	) => Promise<SessionWriteOutcome>;
	updateSession: (
		sessionId: SessionId,
		data: UpdateSessionInput
	) => Promise<SessionWriteOutcome>;
	withSessionBundleExport: <Result>(
		sessionId: SessionId,
		operation: (source: PreparedSessionBundleExport) => Promise<Result>,
		options: Readonly<{
			existingHostWriter: boolean;
			scope: SessionBundleExportScope;
			signal?: AbortSignal;
		}>
	) => Promise<Result>;
	withSessionBundleImport: (
		bundlePath: string,
		options: Readonly<{
			fileSystem?: SessionBundleImportFileSystem;
			signal?: AbortSignal;
		}>
	) => Promise<SessionBundleImportResult>;
}>;

import type { EditMode, FileObservationStore } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type { SessionMessage } from "../message";
import type {
	SessionBundleExportScope,
	SessionBundleImportResult,
} from "../session-bundle-contract";
import type {
	AttachmentExternalizationLease,
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	SessionAttachmentStore,
} from "./attachment-store";
import type {
	PreparedSessionBundleExport,
	SessionBundleImportFileSystem,
} from "./session-bundle";
import type {
	CreateSessionUsageEntryInput,
	SessionUsageEntry,
} from "./session-catalog";
import type {
	CreateEmptySessionInput,
	CreateSessionInput,
	UpdateSessionInput,
} from "./session-lifecycle";
import type {
	CommitSessionRecordInput,
	UpdateSessionSubmissionInput,
} from "./session-records";
import type {
	SessionWriterLock,
	SessionWriterLockOptions,
} from "./session-writer-lock";

/**
 * Write and maintenance capabilities for the rebuildable SQLite projection.
 * Projection rows are deliberately absent from this interface: session reads
 * go through ProjectedSession, which binds each operation to head or a Read
 * Point before exposing the result to facet orchestration.
 */
export type SessionProjection = {
	acquireSessionWriter: (
		sessionId: SessionId,
		options?: SessionWriterLockOptions
	) => Promise<SessionWriterLock>;
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompaction>;
	attachmentStore: SessionAttachmentStore;
	collectAttachments: (
		safetyWindowMs?: number
	) => Promise<AttachmentMaintenanceReport>;
	commitSessionRecord: (input: CommitSessionRecordInput) => Promise<void>;
	confirmSessionImportActivation?: (sessionId: SessionId) => Promise<void>;
	createEmptySession: (
		input: CreateEmptySessionInput
	) => Promise<{ created?: boolean; id: SessionId }>;
	createSession: (
		input: CreateSessionInput
	) => Promise<{ created?: boolean; id: SessionId }>;
	createSessionUsageEntry: (
		input: CreateSessionUsageEntryInput
	) => Promise<SessionUsageEntry>;
	deleteSession: (sessionId: SessionId) => Promise<void>;
	externalizeAttachments: (
		messages: readonly SessionMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	) => Promise<AttachmentExternalizationLease>;
	fileObservationStore?: FileObservationStore;
	hydrateAttachments: (
		messages: readonly SessionMessage[],
		options: AttachmentHydrationOptions
	) => Promise<SessionMessage[]>;
	isSessionImportActivationPending?: (sessionId: SessionId) => Promise<boolean>;
	isSessionImported?: (sessionId: SessionId) => Promise<boolean>;
	resetSessionData: () => Promise<void>;
	setEditMode?: (
		sessionId: SessionId,
		mode: EditMode,
		operationId?: string
	) => Promise<void>;
	updateSession: (
		sessionId: SessionId,
		data: UpdateSessionInput
	) => Promise<void>;
	updateSessionSubmission: (
		input: UpdateSessionSubmissionInput
	) => Promise<void>;
	withSessionBundleExport?: <Result>(
		sessionId: SessionId,
		operation: (source: PreparedSessionBundleExport) => Promise<Result>,
		options: Readonly<{
			existingHostWriter: boolean;
			scope: SessionBundleExportScope;
			signal?: AbortSignal;
		}>
	) => Promise<Result>;
	withSessionBundleImport?: (
		bundlePath: string,
		options: Readonly<{
			fileSystem?: SessionBundleImportFileSystem;
			signal?: AbortSignal;
		}>
	) => Promise<SessionBundleImportResult>;
};

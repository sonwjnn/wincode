import type { EditMode, FileObservationStore } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type {
	SessionBundleExportScope,
	SessionBundleImportResult,
} from "../session-bundle-contract";
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
 * The internal write and maintenance seam between Session facets and the
 * rebuildable SQLite projection. It is not a Session facet; only the storage
 * implementation and focused projection tests depend on it.
 *
 * Raw projection row readers are deliberately absent: Session reads go through
 * ProjectedSession, which binds each operation to head or a Read Point before
 * returning data to facet orchestration. The JSONL store composes this seam
 * with authoritative logs and exposes the asynchronous Session facets.
 */
export type SessionProjection = {
	acquireSessionWriter: (
		sessionId: SessionId,
		options?: SessionWriterLockOptions
	) => Promise<SessionWriterLock>;
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompaction>;
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
	fileObservationStore?: FileObservationStore;
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

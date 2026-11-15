import type { SessionRecord } from "@wincode/agent-core";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { EditMode, FileObservationStore } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type { SessionContextEdit } from "../context-edits";
import type { SessionMessage } from "../message";
import type {
	SessionBundleExportScope,
	SessionBundleImportResult,
} from "../session-bundle-contract";
import type { Session } from "../session-pagination-types";
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
 * The internal seam between the Session facets and SQLite: the projection
 * tables a Session Log can rebuild. No Session consumer depends on it — only
 * the storage implementation and the tests that exercise projection behavior
 * directly do — and it is deliberately not a facet: its work is synchronous
 * SQLite, its write members return nothing, and `listRecentModelSelections` is
 * the one member whose result is not a promise.
 *
 * The JSONL store composes this projection with the authoritative logs and
 * exposes the asynchronous Session facets; `ProjectedSession` handles keep
 * projection reads bound to the required generation or read point.
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
	getCompactions: (sessionId: SessionId) => Promise<SessionCompaction[]>;
	getEditMode: (sessionId: SessionId) => Promise<EditMode>;
	getLatestCompaction: (
		sessionId: SessionId
	) => Promise<SessionCompaction | null>;
	/** Internal only: the JSONL store reads context edits to build a history snapshot. */
	getSessionContextEdits: (
		sessionId: SessionId
	) => Promise<SessionContextEdit[]>;
	getSession: (sessionId: SessionId) => Promise<Session>;
	hydrateAttachments: (
		messages: readonly SessionMessage[],
		options: AttachmentHydrationOptions
	) => Promise<SessionMessage[]>;
	isSessionImportActivationPending?: (sessionId: SessionId) => Promise<boolean>;
	isSessionImported?: (sessionId: SessionId) => Promise<boolean>;
	listRecentModelSelections: (limit: number) => ProviderModelSelection[];
	listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
	listSessions: () => Promise<Session[]>;
	listSessionUsageEntries: (
		sessionId: SessionId
	) => Promise<SessionUsageEntry[]>;
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

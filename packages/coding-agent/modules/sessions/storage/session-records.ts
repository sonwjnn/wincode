import type {
	SessionMessageId,
	SessionRecord,
	SessionRecordId,
	SessionSubmissionStatus,
	SubmissionId,
} from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { FileObservationStore } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type { SessionContextEdit } from "../context-edits";
import type {
	SessionWriteOutcome,
	SessionWriteReceipt,
} from "../session-write-outcome";
import type { AttachmentExternalizationLease } from "./attachment-store";

/**
 * One semantic checkpoint: a Wincode Session Record for one accepted user
 * message, completed Tool Call, or terminal assistant outcome. The commit is
 * atomic at the Session Records boundary; its tagged outcome distinguishes a
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

export type SessionCompactionWriteResult = Readonly<{
	compaction?: SessionCompaction;
	writeOutcome: SessionWriteOutcome;
}>;

/**
 * What one Agent Turn durably writes and reads back while it runs: Session
 * Records, Submissions, Context Edits, compactions, and the file-observation
 * journal the turn's edit tools consult. Every member shares one sequential
 * commit queue and one write-outcome contract.
 *
 * The writer lock it writes under is acquired through `SessionLifecycle`, never
 * here: single-writer is enforced by the Host that owns the writer, not by this
 * type, so this facet accepts no writer and cannot enforce one.
 */
export type SessionRecords = Readonly<{
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompactionWriteResult>;
	appendContextEdit: (
		sessionId: SessionId,
		edit: SessionContextEdit
	) => Promise<SessionWriteOutcome>;
	commitSessionRecord: (
		input: CommitSessionRecordInput
	) => Promise<SessionWriteOutcome>;
	/** Journal of file observations the turn's edit tools read before writing. */
	fileObservationStore?: FileObservationStore;
	findSessionRecordBySubmissionId: (
		sessionId: SessionId,
		submissionId: SubmissionId
	) => Promise<SessionSubmissionRecordReceipt | undefined>;
	listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
	updateSessionSubmission: (
		input: UpdateSessionSubmissionInput
	) => Promise<SessionWriteOutcome>;
}>;

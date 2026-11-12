import type {
	AttachmentId,
	SessionMessageId,
	SessionRecord,
	SessionSubmissionStatus,
} from "@wincode/agent-core";
import type { ModelUsage, ThinkingLevel } from "@wincode/ai";
import type {
	CompactionId,
	SessionHistoryEntryId,
	SessionId,
} from "../../shared/identifiers";
import type { ProviderModelSelection } from "../providers/provider-model-selection";
import type { SessionCompaction } from "./compaction/types";
import type { SessionContextEdit } from "./context-edits";

export type Session = Readonly<{
	createdAt: Date;
	id: SessionId;
	lastMessageAt: Date | null;
	model?: ProviderModelSelection;
	pinned: boolean;
	thinkingLevel?: ThinkingLevel;
	title: string;
}>;

export type SessionPageOptions = Readonly<{
	cursor?: string;
	limit?: number;
}>;

export type SessionHistoryNavigationRequest = Readonly<{
	operationId: string;
	targetEntryId: SessionHistoryEntryId | null;
}>;

export type SessionCatalogPage = Readonly<{
	nextCursor?: string;
	readPoint: string;
	sessions: Session[];
}>;

export type SessionPageCompaction = Readonly<{
	id: CompactionId;
	sessionId: SessionId;
	sequence: number;
	priorCompactionId?: CompactionId;
	summary: Readonly<{
		attachments?: readonly Readonly<{
			attachmentId: AttachmentId;
			available: boolean;
			byteLength: number;
			filename: string;
			height?: number;
			mediaType: string;
			payloadOmitted: true;
			width?: number;
		}>[];
		coveredMessageIds: readonly SessionMessageId[];
		fileOperations?: Readonly<{
			modified: readonly string[];
			read: readonly string[];
		}>;
		formatVersion: 1;
		focus?: string;
		text: string;
	}>;
	firstKeptUiMessageId: SessionMessageId;
	firstKeptAssistantPartIndex?: number;
	throughMessageUiId: SessionMessageId;
	tokensBefore: number;
	estimatedTokensAfter: number;
	trigger: "manual" | "threshold" | "overflow";
	focus?: string;
	summarizationModel: ProviderModelSelection;
	summarizationThinkingLevel?: ThinkingLevel;
	summarizationUsage?: ModelUsage;
	createdAt: Date;
	completedAt: Date;
}>;

export type SessionHistoryPage = Readonly<{
	compactions: SessionPageCompaction[];
	nextCursor?: string;
	readPoint: string;
	records: SessionRecord[];
	session: Session;
}>;

export type SessionHistoryTreeRecordEntry = Readonly<{
	createdAt: Date;
	id: SessionHistoryEntryId;
	kind: "record";
	parentEntryId: SessionHistoryEntryId | null;
	record: SessionRecord;
	recordId: SessionRecord["id"];
	selectedPath: boolean;
	sequence: number;
	sessionModel?: ProviderModelSelection;
	sessionThinkingLevel?: ThinkingLevel;
}>;

export type SessionHistoryTreePluginStateEntry = Readonly<{
	createdAt: Date;
	id: SessionHistoryEntryId;
	key: string;
	kind: "plugin-state";
	operation: "delete" | "set";
	parentEntryId: SessionHistoryEntryId | null;
	pluginId: string;
	schemaVersion: number;
	selectedPath: boolean;
	sequence: number;
}>;

export type SessionHistoryTreePluginEntry = Readonly<{
	createdAt: Date;
	id: SessionHistoryEntryId;
	kind: "plugin-entry";
	parentEntryId: SessionHistoryEntryId | null;
	pluginId: string;
	selectedPath: boolean;
	sequence: number;
	type: string;
}>;

export type SessionHistoryTreeContextEditEntry = Readonly<{
	createdAt: Date;
	id: SessionHistoryEntryId;
	kind: "context-edit";
	operation: "omit" | "replace";
	operationId: string;
	parentEntryId: SessionHistoryEntryId | null;
	selectedPath: boolean;
	sequence: number;
	targetId: SessionMessageId;
}>;

export type SessionHistoryTreeCompactionEntry = Readonly<{
	compactionId: CompactionId;
	createdAt: Date;
	id: SessionHistoryEntryId;
	kind: "compaction";
	parentEntryId: SessionHistoryEntryId | null;
	selectedPath: boolean;
	sequence: number;
	trigger: SessionCompaction["trigger"];
}>;

export type SessionHistoryTreeSubmissionStatusEntry = Readonly<{
	createdAt: Date;
	failure?: string;
	id: SessionHistoryEntryId;
	kind: "submission-status";
	messageId: SessionMessageId;
	parentEntryId: SessionHistoryEntryId | null;
	recordId: SessionRecord["id"];
	selectedPath: boolean;
	sequence: number;
	status: SessionSubmissionStatus;
	submissionId: string;
}>;

export type SessionHistoryTreeEntry =
	| SessionHistoryTreePluginStateEntry
	| SessionHistoryTreeRecordEntry
	| SessionHistoryTreeContextEditEntry
	| SessionHistoryTreeCompactionEntry
	| SessionHistoryTreePluginEntry
	| SessionHistoryTreeSubmissionStatusEntry;

export type SessionHistoryTreePage = Readonly<{
	activeLeafId: SessionHistoryEntryId | null;
	historyGeneration: number;
	entries: SessionHistoryTreeEntry[];
	nextCursor?: string;
	readPoint: string;
}>;

export type SessionHistoryPath = Readonly<{
	activeLeafId: SessionHistoryEntryId | null;
	compactions: SessionCompaction[];
	contextEdits: SessionContextEdit[];
	entries: readonly SessionHistoryTreeEntry[];
	historyGeneration: number;
	model: ProviderModelSelection | undefined;
	records: SessionRecord[];
	thinkingLevel: ThinkingLevel | undefined;
}>;

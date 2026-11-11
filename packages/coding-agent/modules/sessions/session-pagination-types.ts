import type {
	AttachmentId,
	SessionMessageId,
	SessionRecord,
} from "@wincode/agent-core";
import type { ModelUsage, ThinkingLevel } from "@wincode/ai";
import type { CompactionId, SessionId } from "../../shared/identifiers";
import type { ProviderModelSelection } from "../providers/provider-model-selection";

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
	id: string;
	kind: "record";
	parentEntryId: string | null;
	record: SessionRecord;
	recordId: SessionRecord["id"];
	selectedPath: boolean;
	sequence: number;
}>;

export type SessionHistoryTreePluginStateEntry = Readonly<{
	createdAt: Date;
	id: string;
	key: string;
	kind: "plugin-state";
	operation: "delete" | "set";
	parentEntryId: string | null;
	pluginId: string;
	schemaVersion: number;
	selectedPath: boolean;
	sequence: number;
}>;

export type SessionHistoryTreeEntry =
	| SessionHistoryTreePluginStateEntry
	| SessionHistoryTreeRecordEntry;

export type SessionHistoryTreePage = Readonly<{
	activeLeafId: string | null;
	entries: SessionHistoryTreeEntry[];
	nextCursor?: string;
	readPoint: string;
}>;

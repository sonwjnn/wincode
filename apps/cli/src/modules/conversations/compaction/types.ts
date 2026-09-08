import { MODEL_OUTPUT_TOKEN_LIMIT } from "@wincode/ai/model";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type {
	ConversationMessage,
	ConversationMessageUsage,
} from "@/modules/conversations/message";
import type { CompactionAttachmentMetadata } from "../storage/attachment-store";
export const DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS =
	MODEL_OUTPUT_TOKEN_LIMIT;
export const MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS = 256;
export const COMPACTION_TRIGGER_REASONS = [
	"manual",
	"threshold",
	"mid-turn",
	"overflow",
] as const;

export type CompactionTriggerReason =
	(typeof COMPACTION_TRIGGER_REASONS)[number];

export type CompactionSummary = {
	attachments?: CompactionAttachmentMetadata[];
	coveredMessageIds: string[];
	formatVersion: 1;
	focus?: string;
	text: string;
};

export type ConversationCompaction = {
	id: string;
	sessionId: string;
	sequence: number;
	priorCompactionId?: string;
	summary: CompactionSummary;
	firstKeptUiMessageId: string;
	firstKeptAssistantPartIndex?: number;
	throughMessageUiId: string;
	tokensBefore: number;
	estimatedTokensAfter: number;
	trigger: CompactionTriggerReason;
	focus?: string;
	summarizationModel: ChatModelSelection;
	summarizationVariant?: ModelVariant;
	summarizationUsage?: ConversationMessageUsage;
	createdAt: Date;
	completedAt: Date;
};

export type AppendConversationCompactionInput = Omit<
	ConversationCompaction,
	"completedAt" | "createdAt" | "id" | "sequence"
> & {
	id?: string;
	createdAt?: Date;
	completedAt?: Date;
};
export type SummaryGeneratorInput = {
	model: ChatModelSelection;
	variant?: ModelVariant;
	previousSummary?: CompactionSummary;
	serializedMessages: string;
	summaryMessages?: ConversationMessage[];
	focus?: string;
	maxOutputTokens?: number;
	signal?: AbortSignal;
};

export type SummaryGeneratorResult = {
	text: string;
	usage?: ConversationMessageUsage;
};

export type SummaryGenerator = (
	input: SummaryGeneratorInput
) => Promise<SummaryGeneratorResult>;

export type CompactionConversation = {
	sessionId: string;
	messages: readonly ConversationMessage[];
};

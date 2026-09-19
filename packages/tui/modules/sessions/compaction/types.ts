import type { SessionMessageId } from "@wincode/agent-core";
import { MODEL_OUTPUT_TOKEN_LIMIT } from "@wincode/ai/model";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { Except, ReadonlyDeep } from "type-fest";
import type {
	SessionMessage,
	SessionMessageUsage,
} from "@/modules/sessions/message";
import type { CompactionId, SessionId } from "@/shared/identifiers";
import type { CompactionAttachmentMetadata } from "../storage/attachment-store";
export const DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS =
	MODEL_OUTPUT_TOKEN_LIMIT;
export const MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS = 256;
export const COMPACTION_TRIGGER_REASONS = [
	"manual",
	"threshold",
	"overflow",
] as const;

export type CompactionTriggerReason =
	(typeof COMPACTION_TRIGGER_REASONS)[number];

export type CompactionSummary = ReadonlyDeep<{
	attachments?: CompactionAttachmentMetadata[];
	coveredMessageIds: SessionMessageId[];
	formatVersion: 1;
	focus?: string;
	text: string;
}>;

export type SessionCompaction = ReadonlyDeep<{
	id: CompactionId;
	sessionId: SessionId;
	sequence: number;
	priorCompactionId?: CompactionId;
	summary: CompactionSummary;
	firstKeptUiMessageId: SessionMessageId;
	firstKeptAssistantPartIndex?: number;
	throughMessageUiId: SessionMessageId;
	tokensBefore: number;
	estimatedTokensAfter: number;
	trigger: CompactionTriggerReason;
	focus?: string;
	summarizationModel: ChatModelSelection;
	summarizationVariant?: ModelVariant;
	summarizationUsage?: SessionMessageUsage;
	createdAt: Date;
	completedAt: Date;
}>;

export type AppendSessionCompactionInput = Except<
	SessionCompaction,
	"completedAt" | "createdAt" | "id" | "sequence"
> & {
	id?: CompactionId;
	createdAt?: Date;
	completedAt?: Date;
};
export type SummaryGeneratorInput = {
	model: ChatModelSelection;
	variant?: ModelVariant;
	previousSummary?: CompactionSummary;
	serializedMessages: string;
	summaryMessages?: SessionMessage[];
	focus?: string;
	maxOutputTokens?: number;
	signal?: AbortSignal;
};

export type SummaryGeneratorResult = {
	text: string;
	usage?: SessionMessageUsage;
};

export type SummaryGenerator = (
	input: SummaryGeneratorInput
) => Promise<SummaryGeneratorResult>;

export type CompactionSession = {
	sessionId: SessionId;
	messages: readonly SessionMessage[];
};

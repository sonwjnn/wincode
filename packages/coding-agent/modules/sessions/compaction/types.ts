import type { AgentTurnId, SessionMessageId } from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai";
import { MODEL_OUTPUT_TOKEN_LIMIT } from "@wincode/ai";
import type { Except, ReadonlyDeep } from "type-fest";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type {
	SessionMessage,
	SessionMessageUsage,
} from "@/modules/sessions/message";
import type { CompactionId, SessionId } from "@/shared/identifiers";
import type { CompactionAttachmentMetadata } from "../storage/attachment-store";
import type { CompactionFileOperations } from "./file-operations";
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
	fileOperations?: CompactionFileOperations;
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
	summarizationModel: ProviderModelSelection;
	summarizationThinkingLevel?: ThinkingLevel;
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
export type PreparedSummaryRequest = Readonly<{
	estimatedInputTokens: number;
	prompt: string;
}>;

export type SummaryGeneratorInput = {
	model: ProviderModelSelection;
	/** Effective Wincode window for the selected summary target. */
	contextWindowTokens?: number;
	thinkingLevel?: ThinkingLevel;
	previousSummary?: CompactionSummary;
	serializedMessages: string;
	focus?: string;
	maxOutputTokens?: number;
	preparedRequest?: PreparedSummaryRequest;
	reportUsage?: (usage: SessionMessageUsage) => Promise<void>;
	signal?: AbortSignal;
};

export type SummaryGeneratorResult = {
	text: string;
	usage?: SessionMessageUsage;
};

export type SummaryGenerator = (
	input: SummaryGeneratorInput
) => Promise<SummaryGeneratorResult>;

/** The identity and intent one compaction lifecycle callback observes. */
export type CompactionLifecycleContext = Readonly<{
	focus?: string;
	sessionId: SessionId;
	signal?: AbortSignal;
	trigger: CompactionTriggerReason;
	turnId?: AgentTurnId;
}>;

/**
 * A bounded host seam around one compaction. `before` may cancel it or supply
 * handoff text; either way the Session Host still applies its own budgets,
 * reduction checks, persistence and context publication.
 */
export type CompactionLifecycleDecision = Readonly<{
	cancel?: string;
	summary?: string;
}>;

export type CompactionLifecycle = Readonly<{
	before?: (
		context: CompactionLifecycleContext
	) => Promise<CompactionLifecycleDecision | undefined>;
	completed?: (
		entry: SessionCompaction,
		context: CompactionLifecycleContext
	) => Promise<void>;
	failed?: (
		context: CompactionLifecycleContext & Readonly<{ error: unknown }>
	) => Promise<void>;
}>;

export type CompactionSession = {
	sessionId: SessionId;
	messages: readonly SessionMessage[];
};

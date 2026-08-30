import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	CodingMessageUsage,
	ModelVariant,
} from "@wincode/ai";

export const COMPACTION_TRIGGER_REASONS = [
	"manual",
	"threshold",
	"mid-turn",
	"overflow",
] as const;

export type CompactionTriggerReason =
	(typeof COMPACTION_TRIGGER_REASONS)[number];

export type CompactionSummary = {
	formatVersion: 1;
	text: string;
	focus?: string;
	coveredMessageIds: string[];
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
	tokensAfter: number;
	trigger: CompactionTriggerReason;
	focus?: string;
	summarizationModel: ChatModelSelection;
	summarizationVariant?: ModelVariant;
	summarizationUsage?: CodingMessageUsage;
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
	focus?: string;
	signal?: AbortSignal;
};

export type SummaryGeneratorResult = {
	text: string;
	usage?: CodingMessageUsage;
};

export type SummaryGenerator = (
	input: SummaryGeneratorInput
) => Promise<SummaryGeneratorResult>;

export type CompactionConversation = {
	sessionId: string;
	messages: readonly CodingAgentUIMessage[];
};

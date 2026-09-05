export { isModelContextOverflowError } from "@wincode/ai/model-failures";
export { isSettingsCommand, parseCompactCommand } from "./commands";
export type {
	CompactConversationInput,
	CompactConversationResult,
	ConversationCompactionModule,
} from "./compaction";
export {
	ConversationCompactionError,
	compactionSummaryMessageId,
	createCompactionSummaryMessage,
	createConversationCompaction,
	formatCompactionSummaryMessage,
	isCompactionSummaryMessage,
	rebuildActiveMessages,
	serializeMessagesForCompaction,
} from "./compaction";
export type {
	CompactionConfigurationInput,
	CompactionDiagnostic,
	CompactionSettingKey,
	CompactionSettingSource,
	CompactionSettings,
	ResolvedCompactionSettings,
} from "./config";
export {
	COMPACTION_REQUEST_OVERHEAD_TOKENS,
	DEFAULT_COMPACTION_SETTINGS,
	estimateCompactionTokens,
	getCompactionSettingSource,
	resolveCompactionSettingPath,
	resolveCompactionSettings,
} from "./config";
export type {
	OverflowRecoveryInput,
	OverflowReplay,
} from "./overflow-recovery";
export {
	OverflowRecoveryError,
	prepareOverflowReplayMessages,
	recoverContextOverflow,
} from "./overflow-recovery";
export type {
	SummaryModelResolver,
	SummaryTextGenerationOptions,
	SummaryTextGenerator,
} from "./summary-generator";
export {
	COMPACTION_SUMMARY_SYSTEM_PROMPT,
	createDirectSummaryGenerator,
	createLanguageModelSummaryGenerator,
	resolveDirectSummaryModel,
} from "./summary-generator";
export type {
	AppendConversationCompactionInput,
	CompactionConversation,
	CompactionSummary,
	CompactionTriggerReason,
	ConversationCompaction,
	SummaryGenerator,
	SummaryGeneratorInput,
	SummaryGeneratorResult,
} from "./types";
export type { CompactionSettingsOperations } from "./use-compaction-settings";
export {
	createCompactionSettingsOperations,
	useCompactionSettings,
} from "./use-compaction-settings";

import type { ChatReasoningEffort } from "../../sdk.ts";

export type OpenAIProtocolOptions = Readonly<{
	reasoningEffort?: ChatReasoningEffort;
	reasoningSummary?: "detailed";
	store?: boolean;
}>;

export type AnthropicProtocolEffort = Exclude<
	ChatReasoningEffort,
	"minimal" | "none"
>;

export type AnthropicProtocolThinking = Readonly<
	| { type: "adaptive" }
	| { type: "disabled" }
	| { budgetTokens: number; type: "enabled" }
>;

export type AnthropicProtocolOptions = Readonly<{
	effort?: AnthropicProtocolEffort;
	thinking?: AnthropicProtocolThinking;
}>;

export type GoogleProtocolThinkingLevel = Extract<
	ChatReasoningEffort,
	"minimal" | "low" | "medium" | "high"
>;

export type GoogleProtocolOptions = Readonly<{
	thinkingConfig: {
		thinkingBudget?: number;
		thinkingLevel?: GoogleProtocolThinkingLevel;
	};
}>;

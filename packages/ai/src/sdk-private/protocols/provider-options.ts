import type { ThinkingLevel } from "../../sdk.ts";

/** OpenAI wire values; SDK callers use `off` instead of the native `none`. */
export type OpenAIProtocolReasoningEffort =
	| Exclude<ThinkingLevel, "off">
	| "none";

export const openAIProtocolReasoningEffortFor = (
	effort: ThinkingLevel
): OpenAIProtocolReasoningEffort => (effort === "off" ? "none" : effort);

export type OpenAIProtocolOptions = Readonly<{
	reasoningEffort?: OpenAIProtocolReasoningEffort;
	store?: boolean;
}>;

export type AnthropicProtocolEffort = Exclude<ThinkingLevel, "minimal" | "off">;

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
	ThinkingLevel,
	"minimal" | "low" | "medium" | "high"
>;

export type GoogleProtocolOptions = Readonly<{
	thinkingConfig: {
		thinkingBudget?: number;
		thinkingLevel?: GoogleProtocolThinkingLevel;
	};
}>;

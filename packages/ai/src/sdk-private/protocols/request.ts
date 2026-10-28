import type { JsonObject } from "type-fest";
import type { SupportedPromptCacheRetentionTier } from "../../model-metadata.ts";
import type { ModelUsage } from "../../model-usage.ts";
import type { ProviderGenerationCompletion, ThinkingLevel } from "../../sdk.ts";

export type ProtocolPromptPart =
	| Readonly<{ text: string; type: "text" }>
	| Readonly<{ data: string | Uint8Array; mediaType: string; type: "file" }>
	| Readonly<{
			input: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-call";
	  }>
	| Readonly<{
			output: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-result";
	  }>
	| Readonly<{
			errorText: string;
			failure?: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-failure";
	  }>;

export type ProtocolPromptMessage = Readonly<{
	/** Opaque provider continuation retained only for a later request in this turn. */
	continuation?: unknown;
	content: readonly ProtocolPromptPart[];
	role: "assistant" | "tool" | "user";
}>;

export type ProtocolTool = Readonly<{
	description: string;
	inputSchema: JsonObject;
	name: string;
}>;

export type GoogleCachedContentSelection = Readonly<{
	name: string;
	onRejected?: (name: string) => void | Promise<void>;
}>;

/** Protocol-only wire input; authorization remains outside this request. */
export type ProviderProtocolRequest = Readonly<{
	/** Warm requests are best-effort and must not use normal cache fallback retry. */
	cacheWarming?: true;
	googleCachedContent?: GoogleCachedContentSelection;
	messages: readonly ProtocolPromptMessage[];
	modelId: string;
	promptCacheEnabled?: true;
	promptCacheKey?: string;
	promptCacheRetention?: SupportedPromptCacheRetentionTier;
	reasoningEffort?: ThinkingLevel;
	signal?: AbortSignal;
	system?: string;
	tools?: readonly ProtocolTool[];
}>;

export type ProtocolStreamPart =
	| Readonly<{ delta: string; type: "text-delta" | "reasoning-delta" }>
	| Readonly<{
			input: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-call";
	  }>
	| Readonly<{
			completion?: ProviderGenerationCompletion;
			continuation?: unknown;
			type: "finish";
			usage?: ModelUsage;
	  }>;

export type ProtocolGenerationCompletion = NonNullable<
	Extract<ProtocolStreamPart, { type: "finish" }>["completion"]
>;

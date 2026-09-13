// The Model Catalog: Wincode's curated product definition of supported
// models. Retired entries stay in the array so Session Records keep their
// model identity; see ADR-0012. Metadata that is not a product decision
// (cost, limits, reasoning policy) lives in ./model-metadata and the generated
// snapshot it reads.

import { z } from "zod";
import { modelVariantIds } from "./model-metadata";

export type {
	ModelCost,
	ModelCostTier,
	ModelLimits,
	ModelMetadataEntry,
	ModelThinkingPolicy,
	ModelVariant,
} from "./model-metadata";
export { modelVariantIds } from "./model-metadata";

export type ModelLifecycle = "active" | "retired";

export const connectionProviderIds = [
	"openai",
	"anthropic",
	"google",
	"opencode-go",
] as const;

export type ConnectionProviderId = (typeof connectionProviderIds)[number];
export const connectionProviderIdSchema = z.enum(connectionProviderIds);

export const modelRuntimeProviderIds = [
	"anthropic",
	"google",
	"openai",
	"opencode-go",
] as const;
export type ModelRuntimeProviderId = (typeof modelRuntimeProviderIds)[number];

export const modelVariantSchema = z.enum(modelVariantIds);

/**
 * OpenCode Go model families are served by different AI SDK providers behind
 * one connection. The SDK identifies the runtime construction, not the model.
 */
export type OpenCodeGoSdk = "openai" | "anthropic" | "openai-compatible";

export type ModelCatalogEntryBase = {
	connectionProviderId: ConnectionProviderId;
	displayName: string;
	id: string;
	lifecycle: ModelLifecycle;
	provider: ModelRuntimeProviderId;
};
export type ModelCatalogEntry =
	| {
			[K in Exclude<
				ModelRuntimeProviderId,
				"opencode-go"
			>]: ModelCatalogEntryBase & {
				route: "direct";
				connectionProviderId: K;
				provider: K;
			};
	  }[Exclude<ModelRuntimeProviderId, "opencode-go">]
	| (ModelCatalogEntryBase & {
			route: "direct";
			connectionProviderId: "opencode-go";
			provider: "opencode-go";
			sdk: OpenCodeGoSdk;
	  });

export const modelCatalog = [
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6",
		id: "gpt-5.6",
		provider: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6 Sol",
		id: "gpt-5.6-sol",
		provider: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6 Terra",
		id: "gpt-5.6-terra",
		provider: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6 Luna",
		id: "gpt-5.6-luna",
		provider: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-6 Astra",
		id: "gpt-6-astra",
		provider: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.5",
		id: "claude-opus-4-5",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.5 20251101",
		id: "claude-opus-4-5-20251101",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.7",
		id: "claude-opus-4-7",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 5",
		id: "claude-sonnet-5",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.8",
		id: "claude-opus-4-8",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Fable 5",
		id: "claude-fable-5",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Fable 5.1",
		id: "claude-fable-5-1",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 5",
		id: "claude-opus-5",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.6",
		id: "claude-opus-4-6",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 4.6",
		id: "claude-sonnet-4-6",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Haiku 4.5",
		id: "claude-haiku-4-5",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Haiku 4.5 20251001",
		id: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 4.5",
		id: "claude-sonnet-4-5",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 4.5 20250929",
		id: "claude-sonnet-4-5-20250929",
		provider: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3.6 Flash",
		id: "gemini-3.6-flash",
		provider: "google",
		lifecycle: "active",
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3.7 Flash",
		id: "gemini-3.7-flash",
		provider: "google",
		lifecycle: "active",
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3.8 Flash",
		id: "gemini-3.8-flash",
		provider: "google",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Grok 4.6",
		id: "grok-4.6",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GPT 5.6 Luna",
		id: "gpt-5.6-luna",
		provider: "opencode-go",
		sdk: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GLM-5.3-Flash",
		id: "glm-5.3-flash",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GLM-5.3",
		id: "glm-5.3",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GLM-5.2",
		id: "glm-5.2",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GLM-5.1",
		id: "glm-5.1",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Kimi K3",
		id: "kimi-k3",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Kimi K2.7 Code",
		id: "kimi-k2.7-code",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Kimi K2.6",
		id: "kimi-k2.6",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "LongCat-2.0",
		id: "longcat-2.0",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Muse Spark 1.3 Contributor",
		id: "muse-spark-1.3-contributor",
		provider: "opencode-go",
		sdk: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Muse Spark 1.2 Contributor",
		id: "muse-spark-1.2-contributor",
		provider: "opencode-go",
		sdk: "openai",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiniMax M3",
		id: "minimax-m3",
		provider: "opencode-go",
		sdk: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiniMax M2.7",
		id: "minimax-m2.7",
		provider: "opencode-go",
		sdk: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.8 Max",
		id: "qwen3.8-max",
		provider: "opencode-go",
		sdk: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.8 Flash",
		id: "qwen3.8-flash",
		provider: "opencode-go",
		sdk: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.7 Max",
		id: "qwen3.7-max",
		provider: "opencode-go",
		sdk: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.7 Plus",
		id: "qwen3.7-plus",
		provider: "opencode-go",
		sdk: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.6 Plus",
		id: "qwen3.6-plus",
		provider: "opencode-go",
		sdk: "anthropic",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "DeepSeek V4.1 Flash",
		id: "deepseek-v4.1-flash",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "DeepSeek V4 Pro",
		id: "deepseek-v4-pro",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "DeepSeek V4 Flash",
		id: "deepseek-v4-flash",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "DeepSeek V4 Flash Vision Exp",
		id: "deepseek-v4-flash-vision-exp",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiMo-V2.5",
		id: "mimo-v2.5",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiMo-V2.5-Pro",
		id: "mimo-v2.5-pro",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Hy4 preview",
		id: "hy4-preview",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Hy3",
		id: "hy3",
		provider: "opencode-go",
		sdk: "openai-compatible",
		lifecycle: "active",
	},
] as const satisfies readonly ModelCatalogEntry[];

export type SupportedChatModel = (typeof modelCatalog)[number];
export type ReasoningCapableChatModel = Exclude<
	SupportedChatModel,
	{
		readonly provider: "opencode-go";
		readonly sdk: "openai-compatible";
	}
>;

export type SupportedChatModelId = SupportedChatModel["id"];
export type ModelCatalog = readonly SupportedChatModel[];

export type ChatModelSelection = {
	modelId: string;
	providerId: ConnectionProviderId;
};

export const supportedChatModelIds = modelCatalog.map((model) => model.id) as [
	SupportedChatModelId,
	...SupportedChatModelId[],
];
export const supportedChatModelIdSchema = z.enum(supportedChatModelIds);

export const findSupportedChatModel = (
	modelId: string
): SupportedChatModel | null =>
	modelCatalog.find((model) => model.id === modelId) ?? null;

export const findSupportedChatModelSelection = (
	selection: ChatModelSelection
): SupportedChatModel | null =>
	modelCatalog.find(
		(model) =>
			model.id === selection.modelId &&
			model.connectionProviderId === selection.providerId
	) ?? null;

export const isSupportedChatModelSelection = (
	selection: ChatModelSelection
): boolean => findSupportedChatModelSelection(selection) !== null;

/**
 * Whether a Model Target may use this entry for a new Agent Turn. Retired
 * entries stay resolvable so Session Records keep their model identity, but
 * they are never selectable. See ADR-0012.
 */
export const isActiveChatModel = (model: ModelCatalogEntry): boolean =>
	model.lifecycle === "active";

/** Whether the selected runtime adapter can carry reasoning variants. */
export const supportsReasoningVariants = (
	model: SupportedChatModel
): model is ReasoningCapableChatModel =>
	!(model.provider === "opencode-go" && model.sdk === "openai-compatible");

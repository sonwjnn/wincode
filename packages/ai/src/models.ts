import { z } from "zod";
import { modelVariantsByProviderModel } from "./generated/model-variants.generated";

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
/** Compatibility alias. */
export type SupportedProvider = ModelRuntimeProviderId;

export const modelVariantIds = [
	"none",
	"thinking",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ModelVariant = (typeof modelVariantIds)[number];
export const modelVariantSchema = z.enum(modelVariantIds);

/**
 * OpenCode Go model families are served by different AI SDK providers behind
 * one connection. The SDK identifies the runtime construction, not the model.
 */
export type OpenCodeGoSdk = "openai" | "anthropic" | "openai-compatible";

/** USD per 1M tokens. `input` is uncached input. */
export type ModelCost = {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
};

export type ModelCatalogEntryBase = {
	connectionProviderId: ConnectionProviderId;
	displayName: string;
	id: string;
	provider: ModelRuntimeProviderId;
	variants: readonly ModelVariant[];
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
			variants: readonly [];
	  });

export const supportedChatModels = [
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "O3",
		id: "o3",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "O4 Mini",
		id: "o4-mini",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "O3 Pro",
		id: "o3-pro",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "O3 Mini",
		id: "o3-mini",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "O1",
		id: "o1",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "O1 Pro",
		id: "o1-pro",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.1 Codex",
		id: "gpt-5.1-codex",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5 Codex",
		id: "gpt-5-codex",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.2 Pro",
		id: "gpt-5.2-pro",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.4 Pro",
		id: "gpt-5.4-pro",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.5 Pro",
		id: "gpt-5.5-pro",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6",
		id: "gpt-5.6",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6 Sol",
		id: "gpt-5.6-sol",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6 Terra",
		id: "gpt-5.6-terra",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.6 Luna",
		id: "gpt-5.6-luna",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5",
		id: "gpt-5",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5 Mini",
		id: "gpt-5-mini",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5 Nano",
		id: "gpt-5-nano",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5 Pro",
		id: "gpt-5-pro",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.4 Nano",
		id: "gpt-5.4-nano",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.3 Codex Spark",
		id: "gpt-5.3-codex-spark",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.2",
		id: "gpt-5.2",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.3 Codex",
		id: "gpt-5.3-codex",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.4",
		id: "gpt-5.4",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.4 Mini",
		id: "gpt-5.4-mini",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.5",
		id: "gpt-5.5",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.1",
		id: "gpt-5.1",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.1 Codex Max",
		id: "gpt-5.1-codex-max",
		provider: "openai",
		variants: ["low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.2 Codex",
		id: "gpt-5.2-codex",
		provider: "openai",
		variants: ["low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.1 Chat Latest",
		id: "gpt-5.1-chat-latest",
		provider: "openai",
		variants: ["medium"],
	},
	{
		connectionProviderId: "openai",
		route: "direct",
		displayName: "GPT-5.2 Chat Latest",
		id: "gpt-5.2-chat-latest",
		provider: "openai",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.5",
		id: "claude-opus-4-5",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.5 20251101",
		id: "claude-opus-4-5-20251101",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.7",
		id: "claude-opus-4-7",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 5",
		id: "claude-sonnet-5",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.8",
		id: "claude-opus-4-8",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Fable 5",
		id: "claude-fable-5",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Opus 4.6",
		id: "claude-opus-4-6",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 4.6",
		id: "claude-sonnet-4-6",
		provider: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Haiku 4.5",
		id: "claude-haiku-4-5",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Haiku 4.5 20251001",
		id: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 4.5",
		id: "claude-sonnet-4-5",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		route: "direct",
		displayName: "Claude Sonnet 4.5 20250929",
		id: "claude-sonnet-4-5-20250929",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3.1 Flash Lite",
		id: "gemini-3.1-flash-lite",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3.5 Flash",
		id: "gemini-3.5-flash",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3 Flash Preview",
		id: "gemini-3-flash-preview",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3.1 Pro Preview",
		id: "gemini-3.1-pro-preview",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 3 Pro Preview",
		id: "gemini-3-pro-preview",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 2.5 Pro",
		id: "gemini-2.5-pro",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 2.5 Flash",
		id: "gemini-2.5-flash",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini Flash Latest",
		id: "gemini-flash-latest",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini Flash Lite Latest",
		id: "gemini-flash-lite-latest",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemini 2.5 Flash Lite",
		id: "gemini-2.5-flash-lite",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		route: "direct",
		displayName: "Gemma 4 31B IT",
		id: "gemma-4-31b-it",
		provider: "google",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GPT 5.6 Luna",
		id: "gpt-5.6-luna",
		provider: "opencode-go",
		sdk: "openai",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Grok 4.5",
		id: "grok-4.5",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GLM 5.2",
		id: "glm-5.2",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "GLM 5.1",
		id: "glm-5.1",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Kimi K3",
		id: "kimi-k3",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Kimi K2.7 Code",
		id: "kimi-k2.7-code",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Kimi K2.6",
		id: "kimi-k2.6",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiMo V2.5",
		id: "mimo-v2.5",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiMo V2.5 Pro",
		id: "mimo-v2.5-pro",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiniMax M3",
		id: "minimax-m3",
		provider: "opencode-go",
		sdk: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "MiniMax M2.7",
		id: "minimax-m2.7",
		provider: "opencode-go",
		sdk: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.8 Max",
		id: "qwen3.8-max",
		provider: "opencode-go",
		sdk: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.7 Max",
		id: "qwen3.7-max",
		provider: "opencode-go",
		sdk: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.7 Plus",
		id: "qwen3.7-plus",
		provider: "opencode-go",
		sdk: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Qwen3.6 Plus",
		id: "qwen3.6-plus",
		provider: "opencode-go",
		sdk: "anthropic",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "DeepSeek V4 Pro",
		id: "deepseek-v4-pro",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "DeepSeek V4 Flash",
		id: "deepseek-v4-flash",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
	{
		connectionProviderId: "opencode-go",
		route: "direct",
		displayName: "Hy3",
		id: "hy3",
		provider: "opencode-go",
		sdk: "openai-compatible",
		variants: [],
	},
] as const satisfies readonly ModelCatalogEntry[];

export type SupportedChatModel = (typeof supportedChatModels)[number];
export type SupportedChatModelId = SupportedChatModel["id"];
export type ModelCatalog = readonly SupportedChatModel[];

/** The static product catalog consumed by model-selection callers. */
export const modelCatalog: ModelCatalog = supportedChatModels;

export type ChatModelSelection = {
	modelId: string;
	providerId: ConnectionProviderId;
};
/** Focused contract name for a provider/model selection pair. */
export type ModelSelection = ChatModelSelection;

const chatModelSelectionBaseSchema = z.object({
	modelId: z.string(),
	providerId: connectionProviderIdSchema,
});

export const chatModelSelectionSchema =
	chatModelSelectionBaseSchema.superRefine((selection, context) => {
		if (!findSupportedChatModelSelection(selection)) {
			context.addIssue({
				code: "custom",
				message: `Unsupported model selection: ${selection.providerId}/${selection.modelId}`,
			});
		}
	});
/** Focused contract name for the validated selection schema. */
export const modelSelectionSchema = chatModelSelectionSchema;

export const supportedChatModelIds = supportedChatModels.map(
	(model) => model.id
) as [SupportedChatModelId, ...SupportedChatModelId[]];
export const supportedChatModelIdSchema = z.enum(supportedChatModelIds);
export const defaultChatModel = { value: "gpt-5.4-mini" } as const satisfies {
	value: SupportedChatModelId;
};
export const defaultChatModelSelection = {
	modelId: defaultChatModel.value,
	providerId: "openai",
} as const satisfies ChatModelSelection;

export const findSupportedChatModel = (
	modelId: string
): SupportedChatModel | null =>
	supportedChatModels.find((model) => model.id === modelId) ?? null;
export const findSupportedChatModelSelection = (
	selection: ChatModelSelection
): SupportedChatModel | null =>
	supportedChatModels.find(
		(model) =>
			model.id === selection.modelId &&
			model.connectionProviderId === selection.providerId
	) ?? null;
export const isSupportedChatModelSelection = (
	selection: ChatModelSelection
): boolean => findSupportedChatModelSelection(selection) !== null;

/** Resolve the Agent config form `<connectionProviderId>/<modelId>`. */
export const parseCatalogModelSelection = (
	value: string
): ChatModelSelection | null => {
	const separatorIndex = value.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
		return null;
	}
	const selection = {
		modelId: value.slice(separatorIndex + 1),
		providerId: value.slice(0, separatorIndex),
	};
	const parsed = chatModelSelectionBaseSchema.safeParse(selection);
	return parsed.success && findSupportedChatModelSelection(parsed.data)
		? parsed.data
		: null;
};

export const getChatModelRoute = (
	selection: ChatModelSelection
): "direct" | null => findSupportedChatModelSelection(selection)?.route ?? null;

/**
 * Catalog variants are a manual override; entries without curated variants
 * fall back to the generated models.dev snapshot, keyed by
 * `${connectionProviderId}/${modelId}`.
 */
const getCatalogVariants = (model: {
	connectionProviderId: ConnectionProviderId;
	id: string;
	variants: readonly ModelVariant[];
}): readonly ModelVariant[] => {
	if (model.variants.length > 0) {
		return model.variants;
	}
	const generated =
		modelVariantsByProviderModel[`${model.connectionProviderId}/${model.id}`];
	return generated?.variants ?? [];
};

export const getSupportedModelVariants = (
	selection: ChatModelSelection
): readonly ModelVariant[] => {
	const model = findSupportedChatModelSelection(selection);
	return model ? getCatalogVariants(model) : [];
};
export const isSupportedModelVariant = (
	selection: ChatModelSelection,
	variant: ModelVariant
): boolean => getSupportedModelVariants(selection).includes(variant);
export const normalizeModelVariant = (
	selection: ChatModelSelection,
	variant: string | undefined
): ModelVariant | undefined => {
	if (variant === undefined) {
		return;
	}
	const parsed = modelVariantSchema.safeParse(variant);
	if (!parsed.success) {
		return;
	}
	return normalizeModelVariantForModel(
		findSupportedChatModelSelection(selection),
		parsed.data
	);
};

/** Validate variant against the selected catalog entry, not its runtime provider. */
export const normalizeModelVariantForModel = (
	model: {
		id: string;
		connectionProviderId: ConnectionProviderId;
		variants: readonly ModelVariant[];
	} | null,
	variant: string | undefined
): ModelVariant | undefined => {
	if (variant === undefined || !model) {
		return;
	}
	const parsed = modelVariantSchema.safeParse(variant);
	return parsed.success && getCatalogVariants(model).includes(parsed.data)
		? parsed.data
		: undefined;
};

export const normalizeChatModelSelection = (
	selection: string | ChatModelSelection
): ChatModelSelection | null => {
	if (typeof selection !== "string") {
		const parsed = chatModelSelectionSchema.safeParse(selection);
		return parsed.success ? parsed.data : null;
	}
	const model = findSupportedChatModel(selection);
	return model
		? { modelId: model.id, providerId: model.connectionProviderId }
		: null;
};

export const MODEL_VERSION_SUFFIX = /\s+\d{8}$/;

export const formatModelLabel = (displayName: string): string =>
	displayName.replace(MODEL_VERSION_SUFFIX, " (latest)");

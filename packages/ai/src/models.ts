import { z } from "zod";

export const connectionProviderIds = [
	"wincode",
	"openai",
	"anthropic",
	"google",
] as const;

export type ConnectionProviderId = (typeof connectionProviderIds)[number];
export const connectionProviderIdSchema = z.enum(connectionProviderIds);

export type SupportedProvider = "anthropic" | "google" | "openai";

export const modelVariantIds = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ModelVariant = (typeof modelVariantIds)[number];
export const modelVariantSchema = z.enum(modelVariantIds);

type ModelCatalogEntry = {
	connectionProviderId: ConnectionProviderId;
	displayName: string;
	id: string;
	provider: SupportedProvider;
	variants: readonly ModelVariant[];
};

export const supportedChatModels = [
	{
		connectionProviderId: "wincode",
		displayName: "GPT-5.4 Mini",
		id: "gpt-5.4-mini",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "wincode",
		displayName: "Gemini 2.5 Flash",
		id: "gemini-2.5-flash",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "openai",
		displayName: "O3",
		id: "o3",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "O4 Mini",
		id: "o4-mini",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "O3 Pro",
		id: "o3-pro",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "O3 Mini",
		id: "o3-mini",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "O1",
		id: "o1",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "O1 Pro",
		id: "o1-pro",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.1 Codex",
		id: "gpt-5.1-codex",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5 Codex",
		id: "gpt-5-codex",
		provider: "openai",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.2 Pro",
		id: "gpt-5.2-pro",
		provider: "openai",
		variants: ["medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.4 Pro",
		id: "gpt-5.4-pro",
		provider: "openai",
		variants: ["medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.5 Pro",
		id: "gpt-5.5-pro",
		provider: "openai",
		variants: ["medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.6",
		id: "gpt-5.6",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.6 Sol",
		id: "gpt-5.6-sol",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.6 Terra",
		id: "gpt-5.6-terra",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.6 Luna",
		id: "gpt-5.6-luna",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5",
		id: "gpt-5",
		provider: "openai",
		variants: ["minimal", "low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5 Mini",
		id: "gpt-5-mini",
		provider: "openai",
		variants: ["minimal", "low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5 Nano",
		id: "gpt-5-nano",
		provider: "openai",
		variants: ["minimal", "low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5 Pro",
		id: "gpt-5-pro",
		provider: "openai",
		variants: ["high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.4 Nano",
		id: "gpt-5.4-nano",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.3 Codex Spark",
		id: "gpt-5.3-codex-spark",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.2",
		id: "gpt-5.2",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.3 Codex",
		id: "gpt-5.3-codex",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.4",
		id: "gpt-5.4",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.4 Mini",
		id: "gpt-5.4-mini",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.5",
		id: "gpt-5.5",
		provider: "openai",
		variants: ["none", "low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.1",
		id: "gpt-5.1",
		provider: "openai",
		variants: ["none", "low", "medium", "high"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.1 Codex Max",
		id: "gpt-5.1-codex-max",
		provider: "openai",
		variants: ["low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.2 Codex",
		id: "gpt-5.2-codex",
		provider: "openai",
		variants: ["low", "medium", "high", "xhigh"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.1 Chat Latest",
		id: "gpt-5.1-chat-latest",
		provider: "openai",
		variants: ["medium"],
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.2 Chat Latest",
		id: "gpt-5.2-chat-latest",
		provider: "openai",
		variants: ["medium"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Opus 4.5",
		id: "claude-opus-4-5",
		provider: "anthropic",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Opus 4.5 20251101",
		id: "claude-opus-4-5-20251101",
		provider: "anthropic",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Opus 4.7",
		id: "claude-opus-4-7",
		provider: "anthropic",
		variants: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Sonnet 5",
		id: "claude-sonnet-5",
		provider: "anthropic",
		variants: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Opus 4.8",
		id: "claude-opus-4-8",
		provider: "anthropic",
		variants: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Fable 5",
		id: "claude-fable-5",
		provider: "anthropic",
		variants: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Opus 4.6",
		id: "claude-opus-4-6",
		provider: "anthropic",
		variants: ["low", "medium", "high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Sonnet 4.6",
		id: "claude-sonnet-4-6",
		provider: "anthropic",
		variants: ["low", "medium", "high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Haiku 4.5",
		id: "claude-haiku-4-5",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Haiku 4.5 20251001",
		id: "claude-haiku-4-5-20251001",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Sonnet 4.5",
		id: "claude-sonnet-4-5",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Sonnet 4.5 20250929",
		id: "claude-sonnet-4-5-20250929",
		provider: "anthropic",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 3.1 Flash Lite",
		id: "gemini-3.1-flash-lite",
		provider: "google",
		variants: ["minimal", "low", "medium", "high"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 3.5 Flash",
		id: "gemini-3.5-flash",
		provider: "google",
		variants: ["minimal", "low", "medium", "high"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 3 Flash Preview",
		id: "gemini-3-flash-preview",
		provider: "google",
		variants: ["minimal", "low", "medium", "high"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 3.1 Pro Preview",
		id: "gemini-3.1-pro-preview",
		provider: "google",
		variants: ["low", "medium", "high"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 3 Pro Preview",
		id: "gemini-3-pro-preview",
		provider: "google",
		variants: ["low", "high"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 2.5 Pro",
		id: "gemini-2.5-pro",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 2.5 Flash",
		id: "gemini-2.5-flash",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini Flash Latest",
		id: "gemini-flash-latest",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini Flash Lite Latest",
		id: "gemini-flash-lite-latest",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemini 2.5 Flash Lite",
		id: "gemini-2.5-flash-lite",
		provider: "google",
		variants: ["high", "max"],
	},
	{
		connectionProviderId: "google",
		displayName: "Gemma 4 31B IT",
		id: "gemma-4-31b-it",
		provider: "google",
		variants: [],
	},
] as const satisfies readonly ModelCatalogEntry[];

export type SupportedChatModel = (typeof supportedChatModels)[number];
export type SupportedChatModelId = SupportedChatModel["id"];

export type ChatModelSelection = {
	modelId: string;
	providerId: ConnectionProviderId;
};

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

export const supportedChatModelIds = supportedChatModels.map(
	(model) => model.id
) as [SupportedChatModelId, ...SupportedChatModelId[]];
export const supportedChatModelIdSchema = z.enum(supportedChatModelIds);
export const defaultChatModel = { value: "gpt-5.4-mini" } as const satisfies {
	value: SupportedChatModelId;
};
export const defaultChatModelSelection = {
	modelId: defaultChatModel.value,
	providerId: "wincode",
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

export const getSupportedModelVariants = (
	selection: ChatModelSelection
): readonly ModelVariant[] =>
	findSupportedChatModelSelection(selection)?.variants ?? [];
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
	return isSupportedModelVariant(selection, parsed.data)
		? parsed.data
		: undefined;
};

const legacyChatModelSelectionAliases = {
	"gemini-3.5-flash": { modelId: "gemini-2.5-flash", providerId: "wincode" },
} as const satisfies Record<string, ChatModelSelection>;

export const normalizeChatModelSelection = (
	selection: string | ChatModelSelection
): ChatModelSelection | null => {
	if (typeof selection !== "string") {
		const parsed = chatModelSelectionSchema.safeParse(selection);
		return parsed.success ? parsed.data : null;
	}
	const legacySelection = Object.entries(legacyChatModelSelectionAliases).find(
		([key]) => key === selection
	)?.[1];
	if (legacySelection) {
		return legacySelection;
	}
	const model = findSupportedChatModel(selection);
	if (!model || model.connectionProviderId !== "wincode") {
		return null;
	}
	return { modelId: model.id, providerId: model.connectionProviderId };
};

export const isHostChatModelSelection = (
	selection: ChatModelSelection
): boolean =>
	selection.providerId === "wincode" &&
	findSupportedChatModelSelection(selection) !== null;

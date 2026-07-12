import { z } from "zod";

export const connectionProviderIds = [
	"wincode",
	"openai",
	"anthropic",
] as const;

export type ConnectionProviderId = (typeof connectionProviderIds)[number];

export const connectionProviderIdSchema = z.enum(connectionProviderIds);

export type SupportedProvider = "anthropic" | "google" | "openai";

export const supportedChatModelCatalog = [
	{
		connectionProviderId: "wincode",
		displayName: "GPT-5.4 Mini",
		id: "gpt-5.4-mini",
		provider: "openai",
	},
	{
		connectionProviderId: "wincode",
		displayName: "Gemini 2.5 Flash",
		id: "gemini-2.5-flash",
		provider: "google",
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.6 Sol",
		id: "gpt-5.6-sol",
		provider: "openai",
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.6 Terra",
		id: "gpt-5.6-terra",
		provider: "openai",
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.6 Luna",
		id: "gpt-5.6-luna",
		provider: "openai",
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.5",
		id: "gpt-5.5",
		provider: "openai",
	},
	{
		connectionProviderId: "openai",
		displayName: "GPT-5.4 Mini",
		id: "gpt-5.4-mini",
		provider: "openai",
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Sonnet 5",
		id: "claude-sonnet-5",
		provider: "anthropic",
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Opus 4.8",
		id: "claude-opus-4-8",
		provider: "anthropic",
	},
	{
		connectionProviderId: "anthropic",
		displayName: "Claude Haiku 4.5",
		id: "claude-haiku-4-5",
		provider: "anthropic",
	},
] as const;

type SupportedChatModelDefinition = (typeof supportedChatModelCatalog)[number];
export type SupportedChatModelId = SupportedChatModelDefinition["id"];

type SelectionFromDefinition<T extends SupportedChatModelDefinition> =
	T extends SupportedChatModelDefinition
		? { modelId: T["id"]; providerId: T["connectionProviderId"] }
		: never;

export type ChatModelSelection =
	SelectionFromDefinition<SupportedChatModelDefinition>;

type SelectionSchema = z.ZodType<ChatModelSelection>;
const chatModelSelectionSchemaEntries = supportedChatModelCatalog.map((model) =>
	z.object({
		modelId: z.literal(model.id),
		providerId: z.literal(model.connectionProviderId),
	})
);

export const chatModelSelectionSchema = z.union(
	chatModelSelectionSchemaEntries as unknown as [
		SelectionSchema,
		...SelectionSchema[],
	]
);

export const supportedChatModelIds = supportedChatModelCatalog.map(
	(model) => model.id
) as [SupportedChatModelId, ...SupportedChatModelId[]];

export const supportedChatModelIdSchema = z.enum(supportedChatModelIds);

export const supportedChatModels =
	supportedChatModelCatalog satisfies readonly SupportedChatModelDefinition[];

export type SupportedChatModel = (typeof supportedChatModels)[number];

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

export type SupportedChatModelSelection = SupportedChatModelDefinition;

export const findSupportedChatModelSelection = (
	selection: ChatModelSelection
): SupportedChatModelSelection | null =>
	supportedChatModels.find(
		(model) =>
			model.id === selection.modelId &&
			model.connectionProviderId === selection.providerId
	) ?? null;

export const isSupportedChatModelSelection = (
	selection: ChatModelSelection
): boolean => findSupportedChatModelSelection(selection) !== null;

const legacyChatModelSelectionAliases = {
	"gemini-3.5-flash": { modelId: "gemini-2.5-flash", providerId: "wincode" },
} as const satisfies Record<string, ChatModelSelection>;

export const normalizeChatModelSelection = (
	selection: string | ChatModelSelection
): ChatModelSelection | null => {
	if (typeof selection !== "string") {
		return findSupportedChatModelSelection(selection) ? selection : null;
	}

	const legacySelection =
		legacyChatModelSelectionAliases[
			selection as keyof typeof legacyChatModelSelectionAliases
		];
	if (legacySelection) {
		return legacySelection;
	}

	const model = findSupportedChatModel(selection);
	if (!model || model.connectionProviderId !== "wincode") {
		return null;
	}

	return { modelId: model.id, providerId: model.connectionProviderId };
};

export const chatModelSelectionSchemaWithValidation =
	chatModelSelectionSchema.superRefine((selection, context) => {
		if (!findSupportedChatModelSelection(selection)) {
			context.addIssue({
				code: "custom",
				message: `Unsupported model selection: ${selection.providerId}/${selection.modelId}`,
			});
		}
	});

export const isHostChatModelSelection = (
	selection: ChatModelSelection
): boolean =>
	selection.providerId === "wincode" &&
	findSupportedChatModelSelection(selection) !== null;

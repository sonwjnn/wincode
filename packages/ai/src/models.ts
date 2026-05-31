import { z } from "zod";

export const supportedChatModelIds = [
	"claude-opus-4.8",
	"claude-sonnet-4.6",
	"claude-haiku-4.5",
	"gemini-3.5-flash",
	"gemini-3.1-pro-preview",
	"gemini-2.5-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.4-mini",
] as const;

export type SupportedChatModelId = (typeof supportedChatModelIds)[number];

type SupportedChatModelDefinition = {
	displayName: string;
	id: string;
	provider: SupportedProvider;
};

export type SupportedProvider = "anthropic" | "google" | "openai";

export const supportedChatModelIdSchema = z.enum(supportedChatModelIds);

export const supportedChatModels = [
	{
		displayName: "Claude Opus 4.8",
		id: "claude-opus-4.8",
		provider: "anthropic",
	},
	{
		displayName: "Claude Sonnet 4.6",
		id: "claude-sonnet-4.6",
		provider: "anthropic",
	},
	{
		displayName: "Claude Haiku 4.5",
		id: "claude-haiku-4.5",
		provider: "anthropic",
	},
	{
		displayName: "Gemini 3.5 Flash",
		id: "gemini-3.5-flash",
		provider: "google",
	},
	{
		displayName: "Gemini 3.1 Pro Preview",
		id: "gemini-3.1-pro-preview",
		provider: "google",
	},
	{
		displayName: "Gemini 2.5 Pro",
		id: "gemini-2.5-pro",
		provider: "google",
	},
	{
		displayName: "GPT-5.5",
		id: "gpt-5.5",
		provider: "openai",
	},
	{
		displayName: "GPT-5.5 Pro",
		id: "gpt-5.5-pro",
		provider: "openai",
	},
	{
		displayName: "GPT-5.4 Mini",
		id: "gpt-5.4-mini",
		provider: "openai",
	},
] as const satisfies readonly SupportedChatModelDefinition[];

export type SupportedChatModel = (typeof supportedChatModels)[number];

export const defaultChatModel = {
	value: "gpt-5.4-mini",
} as const satisfies { value: SupportedChatModelId };

export const findSupportedChatModel = (
	modelId: string
): SupportedChatModel | null =>
	supportedChatModels.find((model) => model.id === modelId) ?? null;

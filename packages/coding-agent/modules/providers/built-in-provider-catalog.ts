import type { Provider } from "@wincode/ai/sdk";
import {
	type AnthropicProviderOptions,
	createAnthropicProvider,
} from "@wincode/ai/sdk/providers/anthropic";
import {
	createDeepSeekProvider,
	type DeepSeekProviderOptions,
} from "@wincode/ai/sdk/providers/deepseek";
import {
	createGoogleProvider,
	type GoogleProviderOptions,
} from "@wincode/ai/sdk/providers/google";
import {
	createOpenAIProvider,
	type OpenAIProviderOptions,
} from "@wincode/ai/sdk/providers/openai";
import {
	createOpenCodeGoProvider,
	type OpenCodeGoProviderOptions,
} from "@wincode/ai/sdk/providers/opencode-go";
import {
	createOpenRouterProvider,
	type OpenRouterProviderOptions,
} from "@wincode/ai/sdk/providers/openrouter";

export type BuiltInProviderFactoryOptions = Readonly<{
	anthropicProviderOptions?: AnthropicProviderOptions;
	deepSeekProviderOptions?: DeepSeekProviderOptions;
	googleProviderOptions?: GoogleProviderOptions;
	openAIProviderOptions?: OpenAIProviderOptions;
	openCodeGoProviderOptions?: OpenCodeGoProviderOptions;
	openRouterProviderOptions?: OpenRouterProviderOptions;
	sessionId?: string;
}>;

type BuiltInProviderDefinition = Readonly<{
	connectionMode: "api-key" | "api-key-with-model-discovery";
	createProvider: (options: BuiltInProviderFactoryOptions) => Provider;
	defaultModelId?: string;
	displayName: string;
	oauthDisplayName?: string;
}>;

/** User-facing metadata and construction for built-in Provider integrations. */
export const BUILT_IN_PROVIDER_CATALOG = {
	openai: {
		connectionMode: "api-key",
		createProvider: (options) =>
			createOpenAIProvider(options.openAIProviderOptions),
		defaultModelId: "gpt-5.6-luna",
		displayName: "OpenAI Provider SDK",
		oauthDisplayName: "OpenAI browser sign-in",
	},
	anthropic: {
		connectionMode: "api-key",
		createProvider: (options) =>
			createAnthropicProvider(options.anthropicProviderOptions),
		displayName: "Anthropic Provider SDK",
	},
	google: {
		connectionMode: "api-key",
		createProvider: (options) =>
			createGoogleProvider({
				...options.googleProviderOptions,
				...(options.sessionId === undefined
					? {}
					: { sessionId: options.sessionId }),
			}),
		displayName: "Google Provider SDK",
	},
	"opencode-go": {
		connectionMode: "api-key",
		createProvider: (options) =>
			createOpenCodeGoProvider(options.openCodeGoProviderOptions),
		displayName: "OpenCode Go Provider SDK",
	},
	deepseek: {
		connectionMode: "api-key",
		createProvider: (options) =>
			createDeepSeekProvider(options.deepSeekProviderOptions),
		displayName: "DeepSeek Provider SDK",
	},
	openrouter: {
		connectionMode: "api-key-with-model-discovery",
		createProvider: (options) =>
			createOpenRouterProvider(options.openRouterProviderOptions),
		displayName: "OpenRouter Provider SDK",
	},
} as const satisfies Readonly<Record<string, BuiltInProviderDefinition>>;

export type BuiltInProviderId = keyof typeof BUILT_IN_PROVIDER_CATALOG;

const BUILT_IN_PROVIDER_IDS = new Set<string>(
	Object.keys(BUILT_IN_PROVIDER_CATALOG)
);

/** Returns whether an ID is reserved for a first-party Provider. */
export const isBuiltInProviderId = (providerId: string): boolean =>
	BUILT_IN_PROVIDER_IDS.has(providerId);

/** Built-in API-key connection choices; discovery-backed providers use a separate flow. */
export const BUILT_IN_API_KEY_PROVIDER_OPTIONS = Object.freeze(
	Object.entries(BUILT_IN_PROVIDER_CATALOG).flatMap(
		([providerId, definition]) =>
			definition.connectionMode === "api-key"
				? [{ displayName: definition.displayName, providerId }]
				: []
	)
);

export const OPENAI_PROVIDER_ID = "openai" satisfies BuiltInProviderId;
export const OPENROUTER_PROVIDER_ID = "openrouter" satisfies BuiltInProviderId;

import type { Provider } from "@wincode/ai";
import {
	type AnthropicProviderOptions,
	createAnthropicProvider,
	createDeepSeekProvider,
	createGoogleProvider,
	createOpenAIProvider,
	createOpenCodeGoProvider,
	createOpenRouterProvider,
	type DeepSeekProviderOptions,
	type GoogleProviderOptions,
	type OpenAIProviderOptions,
	type OpenCodeGoProviderOptions,
	type OpenRouterProviderOptions,
} from "@wincode/ai";

export type BuiltInProviderFactoryOptions = Readonly<{
	anthropicProviderOptions?: AnthropicProviderOptions;
	deepSeekProviderOptions?: DeepSeekProviderOptions;
	googleProviderOptions?: GoogleProviderOptions;
	openAIProviderOptions?: OpenAIProviderOptions;
	openCodeGoProviderOptions?: OpenCodeGoProviderOptions;
	openRouterProviderOptions?: OpenRouterProviderOptions;
	sessionId?: string;
}>;

export type BuiltInProviderConnectMethod =
	| Readonly<{ kind: "api-key"; methodId: "provider-api-key" }>
	| Readonly<{
			inputPrompt?: string;
			kind: "api-key-with-model-discovery";
			methodId: string;
			successMessage?: string;
	  }>
	| Readonly<{
			displayName: string;
			kind: "oauth";
			methodId: string;
			successMessage?: string;
	  }>;

type BuiltInProviderDefinition = Readonly<{
	connectMethods: readonly BuiltInProviderConnectMethod[];
	createProvider: (options: BuiltInProviderFactoryOptions) => Provider;
	defaultModelId?: string;
	displayName: string;
}>;

/** User-facing metadata and construction for built-in Provider integrations. */
export const BUILT_IN_PROVIDER_CATALOG = {
	openai: {
		connectMethods: [
			{ kind: "api-key", methodId: "provider-api-key" },
			{
				displayName: "OpenAI browser sign-in",
				kind: "oauth",
				methodId: "openai-browser",
				successMessage: "OpenAI connected with browser sign-in.",
			},
		],
		createProvider: (options) =>
			createOpenAIProvider(options.openAIProviderOptions),
		defaultModelId: "gpt-5.6-luna",
		displayName: "OpenAI Provider SDK",
	},
	anthropic: {
		connectMethods: [{ kind: "api-key", methodId: "provider-api-key" }],
		createProvider: (options) =>
			createAnthropicProvider(options.anthropicProviderOptions),
		displayName: "Anthropic Provider SDK",
	},
	google: {
		connectMethods: [{ kind: "api-key", methodId: "provider-api-key" }],
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
		connectMethods: [{ kind: "api-key", methodId: "provider-api-key" }],
		createProvider: (options) =>
			createOpenCodeGoProvider({
				...options.openCodeGoProviderOptions,
				...(options.sessionId === undefined
					? {}
					: { sessionId: options.sessionId }),
			}),
		displayName: "OpenCode Go Provider SDK",
	},
	deepseek: {
		connectMethods: [{ kind: "api-key", methodId: "provider-api-key" }],
		createProvider: (options) =>
			createDeepSeekProvider(options.deepSeekProviderOptions),
		displayName: "DeepSeek Provider SDK",
	},
	openrouter: {
		connectMethods: [
			{
				inputPrompt: "Paste OpenRouter API key",
				kind: "api-key-with-model-discovery",
				methodId: "openrouter-api-key",
				successMessage:
					"OpenRouter Provider connected and Known Models refreshed.",
			},
		],
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
			definition.connectMethods.some(({ kind }) => kind === "api-key")
				? [{ displayName: definition.displayName, providerId }]
				: []
	)
);

export const OPENAI_PROVIDER_ID = "openai" satisfies BuiltInProviderId;
export const OPENROUTER_PROVIDER_ID = "openrouter" satisfies BuiltInProviderId;

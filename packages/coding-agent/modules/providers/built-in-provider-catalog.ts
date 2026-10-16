type BuiltInProviderDefinition = Readonly<{
	connectionMode: "api-key" | "api-key-with-model-discovery";
	displayName: string;
	oauthDisplayName?: string;
}>;

/** User-facing and identity metadata shared by built-in Provider integrations. */
export const BUILT_IN_PROVIDER_CATALOG = {
	openai: {
		connectionMode: "api-key",
		displayName: "OpenAI Provider SDK",
		oauthDisplayName: "OpenAI browser sign-in",
	},
	anthropic: {
		connectionMode: "api-key",
		displayName: "Anthropic Provider SDK",
	},
	google: {
		connectionMode: "api-key",
		displayName: "Google Provider SDK",
	},
	"opencode-go": {
		connectionMode: "api-key",
		displayName: "OpenCode Go Provider SDK",
	},
	deepseek: {
		connectionMode: "api-key",
		displayName: "DeepSeek Provider SDK",
	},
	openrouter: {
		connectionMode: "api-key-with-model-discovery",
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

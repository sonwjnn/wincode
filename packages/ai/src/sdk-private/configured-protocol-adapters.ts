import type { Provider, ProviderModel } from "../sdk.ts";
import { createOpenAICompatibleProvider } from "../sdk-private/openai-compatible.ts";
import { createAnthropicProvider } from "../sdk-providers/anthropic.ts";
import { createGoogleProvider } from "../sdk-providers/google.ts";
import { createOpenAIProvider } from "../sdk-providers/openai.ts";

export type ConfiguredFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export type ConfiguredProviderOptions = Readonly<{
	/** Provider-level API base URL, overridden by modelBaseUrls per model. */
	baseUrl?: string;
	fetch?: ConfiguredFetch;
	id: string;
	modelBaseUrls?: Readonly<Record<string, string>>;
	models: readonly ProviderModel[];
	name?: string;
	resolveApiKey?: (
		signal?: AbortSignal
	) => string | undefined | Promise<string | undefined>;
	sessionId?: string;
}>;

const OPENAI_CHAT_PROTOCOL_ID = "openai-chat";
const OPENAI_COMPATIBLE_PROTOCOL_ID = "openai-compatible";
const OPENAI_RESPONSES_PROTOCOL_ID = "openai-responses";
const ANTHROPIC_PROTOCOL_ID = "anthropic";
const GOOGLE_PROTOCOL_ID = "google";

type ConfiguredProtocolAdapterFactory = (
	options: ConfiguredProviderOptions,
	baseUrl: string | undefined,
	models: readonly ProviderModel[]
) => Provider;

type ConfiguredProtocolAdapter = Readonly<{
	apiAliases: readonly string[];
	create: ConfiguredProtocolAdapterFactory;
}>;

const fetchOptionsFor = (options: ConfiguredProviderOptions) =>
	options.fetch === undefined ? {} : { fetch: options.fetch };

const createOpenAIProtocolAdapter: ConfiguredProtocolAdapterFactory = (
	options,
	baseUrl
) =>
	createOpenAIProvider({
		...fetchOptionsFor(options),
		...(baseUrl === undefined ? {} : { baseUrl }),
		models: [],
	});

const createOpenAICompatibleProtocolAdapter: ConfiguredProtocolAdapterFactory =
	(options, baseUrl, models) => {
		if (baseUrl === undefined) {
			throw new Error(
				`Configured OpenAI-compatible Provider ${options.id} requires a baseUrl.`
			);
		}
		return createOpenAICompatibleProvider({
			baseUrl,
			...fetchOptionsFor(options),
			models,
			providerId: options.id,
			providerName: options.name ?? options.id,
		});
	};

const createAnthropicProtocolAdapter: ConfiguredProtocolAdapterFactory = (
	options,
	baseUrl
) =>
	createAnthropicProvider({
		...fetchOptionsFor(options),
		...(baseUrl === undefined ? {} : { baseUrl }),
		models: [],
	});

const createGoogleProtocolAdapter: ConfiguredProtocolAdapterFactory = (
	options,
	baseUrl
) =>
	createGoogleProvider({
		...fetchOptionsFor(options),
		...(baseUrl === undefined ? {} : { baseUrl }),
		models: [],
		...(options.sessionId === undefined
			? {}
			: { sessionId: options.sessionId }),
	});

const configuredProtocolAdapters: Readonly<
	Record<string, ConfiguredProtocolAdapter | undefined>
> = Object.freeze({
	[OPENAI_CHAT_PROTOCOL_ID]: {
		apiAliases: [],
		create: createOpenAIProtocolAdapter,
	},
	[OPENAI_COMPATIBLE_PROTOCOL_ID]: {
		apiAliases: ["openai-completions"],
		create: createOpenAICompatibleProtocolAdapter,
	},
	[OPENAI_RESPONSES_PROTOCOL_ID]: {
		apiAliases: [],
		create: createOpenAIProtocolAdapter,
	},
	[ANTHROPIC_PROTOCOL_ID]: {
		apiAliases: ["anthropic-messages"],
		create: createAnthropicProtocolAdapter,
	},
	[GOOGLE_PROTOCOL_ID]: {
		apiAliases: ["google-generative-ai"],
		create: createGoogleProtocolAdapter,
	},
});

const configuredProtocolIdByApiName = new Map<string, string>();
for (const [protocolId, adapter] of Object.entries(
	configuredProtocolAdapters
)) {
	if (adapter === undefined) {
		continue;
	}
	for (const apiName of [protocolId, ...adapter.apiAliases]) {
		if (configuredProtocolIdByApiName.has(apiName)) {
			throw new Error(`Duplicate configured Provider API name '${apiName}'.`);
		}
		configuredProtocolIdByApiName.set(apiName, protocolId);
	}
}

export const resolveConfiguredProtocolId = (
	apiName: string
): string | undefined => configuredProtocolIdByApiName.get(apiName);

export const createConfiguredProtocolAdapter = (
	options: ConfiguredProviderOptions,
	protocolId: string,
	baseUrl: string | undefined,
	models: readonly ProviderModel[]
): Provider => {
	const adapter = Object.hasOwn(configuredProtocolAdapters, protocolId)
		? configuredProtocolAdapters[protocolId]
		: undefined;
	if (adapter === undefined) {
		throw new Error(
			`Unsupported configured Provider protocol '${protocolId}'.`
		);
	}
	return adapter.create(options, baseUrl, models);
};

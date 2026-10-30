import {
	type ConfiguredFetch,
	createConfiguredProvider,
	type Provider,
	ProviderError,
	type ProviderModel,
	type ProviderModelCapability,
	resolveConfiguredProtocolId,
	thinkingLevelSchema,
} from "@wincode/ai";
import {
	isPlainObject,
	logger,
	omitUndefined,
	resolveConfigEnvironmentVariables,
} from "@wincode/utils";
import { z } from "zod";
import type { ConfigStore } from "@/shared/config/config-store";
import { isBuiltInProviderId } from "./built-in-provider-catalog";
import { isValidProviderId } from "./provider-stores";

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const CONFIGURED_API_KEY_SOURCE_CREDENTIAL = Object.freeze({
	kind: "models-json-api-key-source",
});

const apiBaseUrlSchema = z
	.string()
	.url()
	.refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const nonWhitespaceStringSchema = z
	.string()
	.refine((value) => value.trim().length > 0);
const modelConfigSchema = z
	.object({
		api: z.string().min(1).optional(),
		baseUrl: apiBaseUrlSchema.optional(),
		contextWindow: z.number().int().positive().optional(),
		cost: z
			.object({
				cacheRead: z.number().finite().nonnegative().optional(),
				cacheWrite: z.number().finite().nonnegative().optional(),
				input: z.number().finite().nonnegative().optional(),
				output: z.number().finite().nonnegative().optional(),
			})
			.strict()
			.optional(),
		id: nonWhitespaceStringSchema,
		input: z.array(z.enum(["image", "text"])).optional(),
		maxTokens: z.number().int().positive().optional(),
		name: nonWhitespaceStringSchema.optional(),
		reasoning: z.boolean().optional(),
		reasoningEfforts: z.array(thinkingLevelSchema).optional(),
	})
	.strict();
const providerConfigSchema = z
	.object({
		api: z.string().min(1).optional(),
		apiKey: z.string().min(1).optional(),
		baseUrl: apiBaseUrlSchema.optional(),
		models: z.array(modelConfigSchema).min(1),
		name: nonWhitespaceStringSchema.optional(),
	})
	.strict();

type ModelsJsonProviderConfig = z.infer<typeof providerConfigSchema>;
type ModelsJsonModelConfig = z.infer<typeof modelConfigSchema>;

export type ModelsJsonProvider = Readonly<{
	hasApiKeySource: boolean;
	provider: Provider;
}>;

export type ModelsJsonProviderLoadOptions = Readonly<{
	commandRunner?: (
		command: string,
		environment: Readonly<Record<string, string | undefined>>,
		signal?: AbortSignal
	) => Promise<string>;
	environment?: Readonly<Record<string, string | undefined>>;
	fetch?: ConfiguredFetch;
	sessionId?: string;
}>;

const modelFor = (
	providerId: string,
	model: ModelsJsonModelConfig,
	api: string
): ProviderModel | undefined => {
	const protocolId = resolveConfiguredProtocolId(api);
	if (protocolId === undefined) {
		return;
	}
	const capabilities = new Set<ProviderModelCapability>(model.input ?? []);
	if (model.reasoning === true || model.reasoningEfforts !== undefined) {
		capabilities.add("reasoning");
	}
	const pricing =
		model.cost === undefined
			? undefined
			: omitUndefined({
					cacheReadPerMillionTokensUsd: model.cost.cacheRead,
					cacheWritePerMillionTokensUsd: model.cost.cacheWrite,
					inputPerMillionTokensUsd: model.cost.input,
					outputPerMillionTokensUsd: model.cost.output,
				});
	return omitUndefined({
		capabilities: capabilities.size === 0 ? undefined : [...capabilities],
		limits: omitUndefined({
			contextWindowTokens: model.contextWindow,
			maxOutputTokens: model.maxTokens,
		}),
		modelId: model.id,
		name: model.name,
		pricing:
			pricing === undefined || Object.keys(pricing).length === 0
				? undefined
				: pricing,
		reasoningEfforts: model.reasoningEfforts,
		protocolId,
		providerId,
	});
};

const commandForApiKey = async (
	command: string,
	environment: Readonly<Record<string, string | undefined>>,
	signal: AbortSignal | undefined
): Promise<string> => {
	if (command.trim().length === 0) {
		throw new Error("Configured API key command failed.");
	}
	const shellCommand =
		process.platform === "win32"
			? [process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", command]
			: ["/bin/sh", "-c", command];
	const commandEnvironment = omitUndefined({
		...process.env,
		...environment,
	}) as Record<string, string>;
	const commandSignal =
		signal === undefined
			? AbortSignal.timeout(10_000)
			: AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
	const child = Bun.spawn(shellCommand, {
		env: commandEnvironment,
		signal: commandSignal,
		stderr: "ignore",
		stdin: "ignore",
		stdout: "pipe",
	});
	try {
		const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let output = "";
		let outputBytes = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			outputBytes += value.byteLength;
			if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
				throw new Error("Configured API key command failed.");
			}
			output += decoder.decode(value, { stream: true });
		}
		output += decoder.decode();
		const exitCode = await child.exited;
		if (exitCode !== 0 || output.trim().length === 0) {
			throw new Error("Configured API key command failed.");
		}
		return output;
	} catch {
		child.kill();
		await child.exited;
		throw new Error("Configured API key command failed.");
	}
};

const apiKeyResolverFor = (
	source: string | undefined,
	options: ModelsJsonProviderLoadOptions,
	environment: Readonly<Record<string, string | undefined>>
): ((signal?: AbortSignal) => Promise<string | undefined>) | undefined => {
	if (source === undefined) {
		return;
	}
	if (source.startsWith("!")) {
		const command = source.slice(1);
		const cache = new Map<string, Promise<string>>();
		return async (signal) => {
			let pending = cache.get(command);
			if (pending === undefined) {
				pending = (options.commandRunner ?? commandForApiKey)(
					command,
					environment,
					signal
				).then((output) => {
					const trimmed = output.trim();
					if (trimmed.length === 0) {
						throw new Error("Configured API key command failed.");
					}
					return trimmed;
				});
				cache.set(command, pending);
			}
			try {
				return await pending;
			} catch (error) {
				if (cache.get(command) === pending) {
					cache.delete(command);
				}
				if (signal?.aborted) {
					throw signal.reason ?? error;
				}
				throw new ProviderError(
					"authentication",
					"Configured API key source could not be resolved."
				);
			}
		};
	}
	return async () => {
		const resolution = resolveConfigEnvironmentVariables(source, environment);
		if ("missingVariable" in resolution) {
			return;
		}
		return resolution.value.length === 0 ? undefined : resolution.value;
	};
};

const warnInvalidProvider = (providerId: string, field?: string): void => {
	logger.warn("Ignoring invalid Provider entry in user models.json", {
		field: field ?? "provider",
		providerId,
	});
};

const providerFor = (
	providerId: string,
	config: ModelsJsonProviderConfig,
	options: ModelsJsonProviderLoadOptions,
	environment: Readonly<Record<string, string | undefined>>
): ModelsJsonProvider | undefined => {
	const models: ProviderModel[] = [];
	const modelBaseUrls: Record<string, string> = {};
	for (const modelConfig of config.models) {
		const api = modelConfig.api ?? config.api;
		if (api === undefined) {
			warnInvalidProvider(providerId, "api");
			return;
		}
		const model = modelFor(providerId, modelConfig, api);
		if (model === undefined) {
			warnInvalidProvider(providerId, "api");
			return;
		}
		models.push(model);
		if (modelConfig.baseUrl !== undefined) {
			modelBaseUrls[model.modelId] = modelConfig.baseUrl;
		}
	}
	const resolveApiKey = apiKeyResolverFor(config.apiKey, options, environment);
	try {
		const provider = createConfiguredProvider({
			...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
			...(options.fetch === undefined ? {} : { fetch: options.fetch }),
			id: providerId,
			modelBaseUrls,
			models,
			...(config.name === undefined ? {} : { name: config.name }),
			...(resolveApiKey === undefined ? {} : { resolveApiKey }),
			...(options.sessionId === undefined
				? {}
				: { sessionId: options.sessionId }),
		});
		return { hasApiKeySource: config.apiKey !== undefined, provider };
	} catch {
		warnInvalidProvider(providerId, "provider");
		return;
	}
};

/** Loads compatible Provider declarations from the user-level `models.json` only. */
export const loadUserModelsJsonProviders = async (
	configStore: ConfigStore,
	workspace: string,
	options: ModelsJsonProviderLoadOptions = {}
): Promise<readonly ModelsJsonProvider[]> => {
	const snapshot = await configStore.getNamespaceSnapshot(workspace, "models");
	const userDocument = snapshot.sources.find(
		({ scope }) => scope === "global"
	)?.document;
	if (userDocument === undefined) {
		return [];
	}
	const configuredProviders = userDocument.providers;
	if (!isPlainObject(configuredProviders)) {
		logger.warn("Ignoring invalid providers object in user models.json");
		return [];
	}
	const environment = options.environment ?? process.env;
	const result: ModelsJsonProvider[] = [];
	for (const [providerId, rawConfig] of Object.entries(configuredProviders)) {
		if (!isValidProviderId(providerId)) {
			warnInvalidProvider(providerId, "id");
			continue;
		}
		if (isBuiltInProviderId(providerId)) {
			warnInvalidProvider(providerId, "reserved-id");
			continue;
		}
		const parsed = providerConfigSchema.safeParse(rawConfig);
		if (!parsed.success) {
			warnInvalidProvider(
				providerId,
				parsed.error.issues[0]?.path.map(String).join(".")
			);
			continue;
		}
		const provider = providerFor(providerId, parsed.data, options, environment);
		if (provider !== undefined) {
			result.push(provider);
		}
	}
	return result;
};

export { CONFIGURED_API_KEY_SOURCE_CREDENTIAL };

import type { SupportedPromptCacheRetentionTier } from "./model-metadata";

export type ProviderModelCapability =
	| "file"
	| "image"
	| "reasoning"
	| "text"
	| "tools";

/** Provider-neutral identity used in Session, Agent, and Plugin selections. */
export type ProviderModelSelection = Readonly<{
	modelId: string;
	providerId: string;
}>;

/** A provider-owned model; optional metadata is preserved rather than inferred. */
export type ProviderModel = Readonly<{
	/** When present, unsupported image/file/tool inputs fail before provider dispatch. */
	capabilities?: readonly ProviderModelCapability[];
	/** Cache retention choices this model explicitly supports. */
	promptCacheRetentionTiers?: readonly SupportedPromptCacheRetentionTier[];
	/** Exact per-retention cache lifetime published for this Provider Model. */
	promptCacheRetentionTtlMs?: Readonly<
		Partial<Record<SupportedPromptCacheRetentionTier, number>>
	>;
	limits?: Readonly<{
		contextWindowTokens?: number;
		maxOutputTokens?: number;
	}>;
	modelId: string;
	/** Reasoning effort values this model explicitly supports. */
	reasoningEfforts?: readonly ChatReasoningEffort[];
	/** Exact published price data; absent rates remain unknown. */
	pricing?: Readonly<{
		cacheReadPerMillionTokensUsd?: number;
		cacheWritePerMillionTokensUsd?: number;
		inputPerMillionTokensUsd?: number;
		outputPerMillionTokensUsd?: number;
		tiers?: readonly Readonly<{
			cacheReadPerMillionTokensUsd?: number;
			cacheWritePerMillionTokensUsd?: number;
			inputPerMillionTokensUsd: number;
			inputTokensAbove: number;
			outputPerMillionTokensUsd: number;
		}>[];
	}>;
	protocolId: string;
	providerId: string;
}>;

const isPositiveSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Rejects invalid caller-supplied output budgets at SDK request boundaries. */
export const assertValidMaxOutputTokens = (
	requested: number | undefined
): void => {
	if (requested !== undefined && !isPositiveSafeInteger(requested)) {
		throw new RangeError("maxOutputTokens must be a positive safe integer.");
	}
};

/** Applies a validated request budget without inferring one from model metadata. */
export const maxOutputTokensForRequest = (
	requested: number | undefined,
	model: ProviderModel
): number | undefined => {
	assertValidMaxOutputTokens(requested);
	const maximum = model.limits?.maxOutputTokens;
	if (maximum !== undefined && !isPositiveSafeInteger(maximum)) {
		throw new RangeError(
			"Provider Model maxOutputTokens must be a positive safe integer."
		);
	}
	if (requested === undefined) {
		return;
	}
	return maximum === undefined ? requested : Math.min(requested, maximum);
};

export type ChatContentPart =
	| Readonly<{ text: string; type: "text" }>
	| Readonly<{
			data: string | Uint8Array;
			mediaType: string;
			type: "file" | "image";
	  }>
	| Readonly<{
			input: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-call";
	  }>
	| Readonly<{
			output: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-result";
	  }>
	| Readonly<{
			errorText: string;
			failure?: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-failure";
	  }>;

type ChatMessageContent = Readonly<{
	content: readonly ChatContentPart[];
}>;

export type ChatMessage =
	| (ChatMessageContent &
			Readonly<{
				/** Opaque provider continuation returned on success. */
				continuation?: unknown;
				role: "assistant";
			}>)
	| (ChatMessageContent &
			Readonly<{
				continuation?: never;
				role: "tool" | "user";
			}>);

export type ChatTool = Readonly<{
	description?: string;
	inputSchema: Readonly<Record<string, unknown>>;
	name: string;
}>;

export type ChatReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type ChatRequest = Readonly<{
	cacheRetention?: SupportedPromptCacheRetentionTier;
	cacheWarming?: true;
	maxOutputTokens?: number;
	messages: readonly ChatMessage[];
	modelId: string;
	promptCacheKey?: string;
	providerId: string;
	reasoningEffort?: ChatReasoningEffort;
	signal?: AbortSignal;
	system?: string;
	tools?: readonly ChatTool[];
}>;

export type ProviderChatRequest = Readonly<{
	cacheRetention?: ChatRequest["cacheRetention"];
	cacheWarming?: ChatRequest["cacheWarming"];
	maxOutputTokens?: ChatRequest["maxOutputTokens"];
	messages: ChatRequest["messages"];
	promptCacheKey?: ChatRequest["promptCacheKey"];
	reasoningEffort?: ChatRequest["reasoningEffort"];
	system?: ChatRequest["system"];
	tools?: ChatRequest["tools"];
}>;

export type ProviderAuthorization = Readonly<{
	authorization: unknown;
	/** A rotated credential is persisted before the next request resolves auth. */
	credential?: unknown;
}>;

/** Provider finishes are folded into the SDK's one successful terminal outcome. */
export type ProviderChatFinish = Readonly<{
	continuation?: unknown;
	type: "finish";
}>;

/** Provider stream events; the SDK appends the single terminal outcome. */
export type ProviderChatEvent =
	| Readonly<{ delta: string; type: "text-delta" | "reasoning-delta" }>
	| Readonly<{
			input: unknown;
			toolCallId: string;
			toolName: string;
			type: "tool-call";
	  }>
	| Readonly<{
			type: "usage";
			usage: Readonly<{
				cacheReadTokens?: number;
				cacheWriteTokens?: number;
				inputTokens?: number;
				outputTokens?: number;
				reasoningTokens?: number;
				totalTokens?: number;
			}>;
	  }>
	| ProviderChatFinish;

export type ProviderChatContext = Readonly<{
	authorization: unknown;
	model: ProviderModel;
	signal?: AbortSignal;
}>;

/** Authorization and cancellation passed to provider-owned model discovery. */
export type ProviderModelDiscoveryContext = Readonly<{
	authorization: unknown;
	signal?: AbortSignal;
}>;

/** A registered provider owns its authorization lifecycle, model list, and wire behavior. */
export type Provider = Readonly<{
	id: string;
	/** Static baseline models remain available alongside discovered models. */
	models: readonly ProviderModel[];
	/** Return current dynamic models; rejection or cancellation preserves the last-known list. */
	discoverModels?: (
		context: ProviderModelDiscoveryContext
	) => readonly ProviderModel[] | Promise<readonly ProviderModel[]>;
	/** Return null when not configured; include credential only when rotating it. */
	resolveAuthorization: (
		input: Readonly<{
			credential: unknown | undefined;
			signal?: AbortSignal;
		}>
	) => ProviderAuthorization | null | Promise<ProviderAuthorization | null>;
	streamChat: (
		request: ProviderChatRequest,
		context: ProviderChatContext
	) => AsyncIterable<ProviderChatEvent>;
	/** Synchronously reports whether this credential/model can enforce a bounded output request. */
	canEnforceMaxOutputTokens?: (
		input: Readonly<{
			credential: unknown;
			model: ProviderModel;
		}>
	) => boolean;
	/** Release resources owned by this Provider when its collection is disposed. */
	close?: () => void | Promise<void>;
}>;

/** Application-owned persistence for one credential per provider ID in this collection. */
export type CredentialStore = Readonly<{
	delete: (providerId: string) => void | Promise<void>;
	get: (
		providerId: string
	) => unknown | undefined | Promise<unknown | undefined>;
	set: (providerId: string, credential: unknown) => void | Promise<void>;
}>;

/** Cancellation options for an atomic model snapshot write. */
export type ModelStoreWriteOptions = Readonly<{
	signal?: AbortSignal;
}>;

/** Application-owned persistence for last-successful dynamic discovery results. */
export type ModelStore = Readonly<{
	get: (
		providerId: string
	) =>
		| readonly ProviderModel[]
		| undefined
		| Promise<readonly ProviderModel[] | undefined>;
	/**
	 * Atomically writes the snapshot. If signal aborts before commit, a conforming
	 * store rejects without changing its snapshot. Success means commit completed; later cancellation is too late.
	 */
	set: (
		providerId: string,
		models: readonly ProviderModel[],
		options: ModelStoreWriteOptions
	) => void | Promise<void>;
}>;

export type RefreshModelsOptions = Readonly<{
	signal?: AbortSignal;
}>;

export type ChatFailure =
	| Readonly<{ code: "provider-not-found"; providerId: string }>
	| Readonly<{ code: "model-not-found"; modelId: string; providerId: string }>
	| Readonly<{
			capability?: ProviderModelCapability;
			code: "unsupported-capability";
			modelId: string;
			providerId: string;
	  }>
	| Readonly<{
			code: "authentication" | "credential-store" | "provider" | "transport";
			message: string;
			providerId: string;
	  }>;

export type ChatOutcome =
	| Readonly<{ continuation?: unknown; status: "success" }>
	| Readonly<{ failure: ChatFailure; status: "failure" }>
	| Readonly<{ reason?: string; status: "aborted" }>;

/** Consumer events exclude ProviderChatFinish; the terminal outcome carries it. */
export type ChatEvent =
	| Exclude<ProviderChatEvent, ProviderChatFinish>
	| Readonly<{ outcome: ChatOutcome; type: "terminal" }>;

export type ProviderErrorCode =
	| "authentication"
	| "provider"
	| "transport"
	| "unsupported-capability";

/** Throw from a Provider to preserve a structured chat failure category. */
export class ProviderError extends Error {
	readonly capability: ProviderModelCapability | undefined;
	readonly code: ProviderErrorCode;

	constructor(
		code: ProviderErrorCode,
		message: string,
		options: Readonly<{
			capability?: ProviderModelCapability;
			cause?: unknown;
		}> = {}
	) {
		super(message, { cause: options.cause });
		this.name = "ProviderError";
		this.code = code;
		this.capability = options.capability;
	}
}

export type ProviderCollection = Readonly<{
	chat: (request: ChatRequest) => AsyncIterable<ChatEvent>;
	/** Checks bounded-output support from stored credentials without resolving authorization or network access. */
	canEnforceMaxOutputTokens: (
		providerId: string,
		modelId: string
	) => Promise<boolean>;
	/** Closes every registered Provider once and waits for all cleanup attempts. */
	close: () => Promise<void>;
	deleteCredential: (providerId: string) => Promise<void>;
	/** Known models whose provider has a stored credential; this does not contact the provider. */
	getAvailable: () => Promise<readonly ProviderModel[]>;
	getModel: (providerId: string, modelId: string) => ProviderModel | undefined;
	/** Returns in-memory last-known models. Restore the store before listing a fresh instance. */
	getModels: () => readonly ProviderModel[];
	/** Loads persisted dynamic models for providers registered so far, without network access. */
	restoreModels: () => Promise<void>;
	/** Discovers and persists models; failures leave the last-known list unchanged. */
	refreshModels: (
		providerId: string,
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	register: (provider: Provider) => void;
	setCredential: (providerId: string, credential: unknown) => Promise<void>;
}>;

export type ProviderCollectionOptions = Readonly<{
	credentialStore?: CredentialStore;
	modelStore?: ModelStore;
}>;

type RegisteredProvider = Readonly<{
	models: readonly ProviderModel[];
	provider: Provider;
}>;

type ChatTarget = Readonly<{
	kind: "selected";
	model: ProviderModel;
	registered: RegisteredProvider;
}>;

type ChatSelection =
	| ChatTarget
	| Readonly<{ failure: ChatFailure; kind: "failed" }>;

type CredentialStoreFailure = Readonly<{
	cause: unknown;
	credentialStoreFailure: true;
}>;

const createDefaultCredentialStore = (): CredentialStore => {
	const credentials = new Map<string, unknown>();
	return {
		delete: (providerId) => {
			credentials.delete(providerId);
		},
		get: (providerId) => credentials.get(providerId),
		set: (providerId, credential) => {
			credentials.set(providerId, credential);
		},
	};
};

const isCredentialStoreFailure = (
	value: unknown
): value is CredentialStoreFailure =>
	typeof value === "object" &&
	value !== null &&
	"credentialStoreFailure" in value;

const credentialStoreFailure = (cause: unknown): CredentialStoreFailure => ({
	cause,
	credentialStoreFailure: true,
});

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isAbortError = (error: unknown): boolean =>
	error instanceof Error && error.name === "AbortError";

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

const CHAT_REASONING_EFFORTS: readonly ChatReasoningEffort[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const PROMPT_CACHE_RETENTION_TIERS: readonly SupportedPromptCacheRetentionTier[] =
	["short", "long"];
const PROVIDER_MODEL_CAPABILITIES: readonly ProviderModelCapability[] = [
	"file",
	"image",
	"reasoning",
	"text",
	"tools",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

const isStringArrayOf = <Value extends string>(
	value: unknown,
	allowedValues: readonly Value[]
): value is readonly Value[] =>
	Array.isArray(value) &&
	value.every(
		(candidate) =>
			typeof candidate === "string" &&
			allowedValues.includes(candidate as Value)
	);

const isOptionalStringArrayOf = <Value extends string>(
	value: unknown,
	allowedValues: readonly Value[]
): boolean => value === undefined || isStringArrayOf(value, allowedValues);

const isOptionalNumberRecord = (
	value: unknown,
	allowedKeys: readonly string[]
): boolean =>
	value === undefined ||
	(isRecord(value) &&
		Object.entries(value).every(
			([key, candidate]) =>
				allowedKeys.includes(key) &&
				(candidate === undefined || isNonNegativeFiniteNumber(candidate))
		));

const isOptionalProviderModelLimits = (value: unknown): boolean =>
	value === undefined ||
	(isRecord(value) &&
		Object.entries(value).every(([key, candidate]) => {
			if (key === "contextWindowTokens") {
				return candidate === undefined || isPositiveSafeInteger(candidate);
			}
			if (key === "maxOutputTokens") {
				return candidate === undefined || isPositiveSafeInteger(candidate);
			}
			return false;
		}));

const isProviderModelPricingTier = (value: unknown): boolean =>
	isRecord(value) &&
	Number.isSafeInteger(value.inputTokensAbove) &&
	(value.inputTokensAbove as number) > 0 &&
	isOptionalNumberRecord(
		{
			cacheReadPerMillionTokensUsd: value.cacheReadPerMillionTokensUsd,
			cacheWritePerMillionTokensUsd: value.cacheWritePerMillionTokensUsd,
			inputPerMillionTokensUsd: value.inputPerMillionTokensUsd,
			outputPerMillionTokensUsd: value.outputPerMillionTokensUsd,
		},
		[
			"cacheReadPerMillionTokensUsd",
			"cacheWritePerMillionTokensUsd",
			"inputPerMillionTokensUsd",
			"outputPerMillionTokensUsd",
		]
	) &&
	isNonNegativeFiniteNumber(value.inputPerMillionTokensUsd) &&
	isNonNegativeFiniteNumber(value.outputPerMillionTokensUsd);

const isOptionalProviderModelPricing = (value: unknown): boolean =>
	value === undefined ||
	(isRecord(value) &&
		isOptionalNumberRecord(
			{
				cacheReadPerMillionTokensUsd: value.cacheReadPerMillionTokensUsd,
				cacheWritePerMillionTokensUsd: value.cacheWritePerMillionTokensUsd,
				inputPerMillionTokensUsd: value.inputPerMillionTokensUsd,
				outputPerMillionTokensUsd: value.outputPerMillionTokensUsd,
			},
			[
				"cacheReadPerMillionTokensUsd",
				"cacheWritePerMillionTokensUsd",
				"inputPerMillionTokensUsd",
				"outputPerMillionTokensUsd",
			]
		) &&
		(value.tiers === undefined ||
			(Array.isArray(value.tiers) &&
				value.tiers.every(isProviderModelPricingTier))));

const isOptionalPromptCacheRetentionTtlRecord = (value: unknown): boolean =>
	value === undefined ||
	(isRecord(value) &&
		Object.values(value).every(
			(candidate) =>
				typeof candidate === "number" &&
				Number.isSafeInteger(candidate) &&
				candidate > 0
		));

const isProviderModel = (value: unknown): value is ProviderModel =>
	isRecord(value) &&
	isNonEmptyString(value.providerId) &&
	isNonEmptyString(value.modelId) &&
	isNonEmptyString(value.protocolId) &&
	isOptionalStringArrayOf(value.capabilities, PROVIDER_MODEL_CAPABILITIES) &&
	isOptionalStringArrayOf(value.reasoningEfforts, CHAT_REASONING_EFFORTS) &&
	isOptionalStringArrayOf(
		value.promptCacheRetentionTiers,
		PROMPT_CACHE_RETENTION_TIERS
	) &&
	isOptionalPromptCacheRetentionTtlRecord(value.promptCacheRetentionTtlMs) &&
	isOptionalProviderModelLimits(value.limits) &&
	isOptionalProviderModelPricing(value.pricing);

const normalizeProviderModel = (model: ProviderModel): ProviderModel => {
	const pricing = model.pricing;
	if (pricing?.tiers === undefined) {
		return model;
	}
	return {
		...model,
		pricing: {
			...pricing,
			tiers: [...pricing.tiers].sort(
				(left, right) => left.inputTokensAbove - right.inputTokensAbove
			),
		},
	};
};

const validateProviderModels = (
	value: unknown,
	providerId: string,
	source: string
): readonly ProviderModel[] => {
	if (!Array.isArray(value)) {
		throw new Error(`${source} for provider ${providerId} must be an array.`);
	}
	const models: ProviderModel[] = [];
	const modelIds = new Set<string>();
	for (const candidate of value as readonly unknown[]) {
		if (!isProviderModel(candidate) || candidate.providerId !== providerId) {
			throw new Error(
				`${source} contains an invalid model for provider ${providerId}.`
			);
		}
		if (modelIds.has(candidate.modelId)) {
			throw new Error(
				`${source} contains duplicate model ID for provider ${providerId}: ${candidate.modelId}`
			);
		}
		modelIds.add(candidate.modelId);
		models.push(normalizeProviderModel(candidate));
	}
	return models;
};

const modelsForProvider = (
	registered: RegisteredProvider,
	discovered: readonly ProviderModel[]
): readonly ProviderModel[] => {
	const models = new Map<string, ProviderModel>();
	for (const model of registered.models) {
		models.set(model.modelId, model);
	}
	for (const model of discovered) {
		// Static metadata remains authoritative for an identity it already declares.
		if (!models.has(model.modelId)) {
			models.set(model.modelId, model);
		}
	}
	return [...models.values()];
};

const failureForError = (
	error: unknown,
	providerId: string,
	modelId: string
): ChatFailure => {
	if (isCredentialStoreFailure(error)) {
		return {
			code: "credential-store",
			message: errorMessage(error.cause),
			providerId,
		};
	}
	if (error instanceof ProviderError) {
		if (error.code === "unsupported-capability") {
			return {
				...(error.capability ? { capability: error.capability } : {}),
				code: error.code,
				modelId,
				providerId,
			};
		}
		return { code: error.code, message: error.message, providerId };
	}
	return { code: "provider", message: errorMessage(error), providerId };
};

const requestedCapabilities = (
	request: ChatRequest
): readonly ProviderModelCapability[] => {
	const capabilities = new Set<ProviderModelCapability>();
	for (const message of request.messages) {
		for (const part of message.content) {
			if (part.type === "file" || part.type === "image") {
				capabilities.add(part.type);
			}
			if (part.type === "tool-call" || part.type === "tool-result") {
				capabilities.add("tools");
			}
		}
	}
	if (request.tools && request.tools.length > 0) {
		capabilities.add("tools");
	}
	return [...capabilities];
};

const terminal = (outcome: ChatOutcome): ChatEvent => ({
	outcome,
	type: "terminal",
});

const terminalForStreamError = (
	error: unknown,
	request: ChatRequest
): ChatEvent => {
	if (request.signal?.aborted || isAbortError(error)) {
		return terminal({
			reason: request.signal?.reason
				? errorMessage(request.signal.reason)
				: errorMessage(error),
			status: "aborted",
		});
	}
	return terminal({
		failure: failureForError(error, request.providerId, request.modelId),
		status: "failure",
	});
};

const selectChatTarget = (
	providers: ReadonlyMap<string, RegisteredProvider>,
	dynamicModels: ReadonlyMap<string, readonly ProviderModel[]>,
	request: ChatRequest
): ChatSelection => {
	const registered = providers.get(request.providerId);
	if (!registered) {
		return {
			failure: { code: "provider-not-found", providerId: request.providerId },
			kind: "failed",
		};
	}
	const model = modelsForProvider(
		registered,
		dynamicModels.get(request.providerId) ?? []
	).find((candidate) => candidate.modelId === request.modelId);
	if (!model) {
		return {
			failure: {
				code: "model-not-found",
				modelId: request.modelId,
				providerId: request.providerId,
			},
			kind: "failed",
		};
	}
	const unsupportedCapability = model.capabilities
		? requestedCapabilities(request).find(
				(capability) => !model.capabilities?.includes(capability)
			)
		: undefined;
	if (unsupportedCapability) {
		return {
			failure: {
				capability: unsupportedCapability,
				code: "unsupported-capability",
				modelId: request.modelId,
				providerId: request.providerId,
			},
			kind: "failed",
		};
	}
	return { kind: "selected", model, registered };
};

/** Creates an isolated provider collection; the default credential store is in-memory. */
export const createProviderCollection = (
	options: ProviderCollectionOptions = {}
): ProviderCollection => {
	const credentialStore =
		options.credentialStore ?? createDefaultCredentialStore();
	const modelStore = options.modelStore;
	const providers = new Map<string, RegisteredProvider>();
	const dynamicModels = new Map<string, readonly ProviderModel[]>();
	const restoredProviders = new Set<string>();
	const authQueues = new Map<string, Promise<void>>();

	const withProviderCredentialLock = async <T>(
		providerId: string,
		operation: () => Promise<T>
	): Promise<T> => {
		const previous = authQueues.get(providerId) ?? Promise.resolve();
		const next = Promise.withResolvers<void>();
		authQueues.set(providerId, next.promise);
		await previous;
		try {
			return await operation();
		} finally {
			next.resolve();
			if (authQueues.get(providerId) === next.promise) {
				authQueues.delete(providerId);
			}
		}
	};

	const getRegisteredProvider = (providerId: string): RegisteredProvider => {
		const registered = providers.get(providerId);
		if (!registered) {
			throw new Error(`Unknown provider: ${providerId}`);
		}
		return registered;
	};

	const getProviderModels = (providerId: string): readonly ProviderModel[] => {
		const registered = providers.get(providerId);
		return registered
			? modelsForProvider(registered, dynamicModels.get(providerId) ?? [])
			: [];
	};

	const canEnforceMaxOutputTokens = async (
		providerId: string,
		modelId: string
	): Promise<boolean> => {
		const registered = providers.get(providerId);
		const model = getProviderModels(providerId).find(
			(candidate) => candidate.modelId === modelId
		);
		if (registered === undefined || model === undefined) {
			return false;
		}
		return withProviderCredentialLock(providerId, async () => {
			let credential: unknown | undefined;
			try {
				credential = await credentialStore.get(providerId);
			} catch {
				return false;
			}
			if (credential === undefined) {
				return false;
			}
			try {
				return (
					registered.provider.canEnforceMaxOutputTokens?.({
						credential,
						model,
					}) ?? true
				);
			} catch {
				return false;
			}
		});
	};

	const resolveAuthorization = async (
		provider: Provider,
		signal: AbortSignal | undefined
	): Promise<unknown> =>
		withProviderCredentialLock(provider.id, async () => {
			if (signal?.aborted) {
				throw signal.reason ?? new DOMException("Aborted", "AbortError");
			}
			let credential: unknown | undefined;
			try {
				credential = await credentialStore.get(provider.id);
			} catch (error) {
				throw credentialStoreFailure(error);
			}
			const resolved = await provider.resolveAuthorization({
				credential,
				signal,
			});
			if (!resolved) {
				throw new ProviderError(
					"authentication",
					`Provider ${provider.id} has no usable credentials.`
				);
			}
			if (resolved.credential !== undefined) {
				try {
					await credentialStore.set(provider.id, resolved.credential);
				} catch (error) {
					throw credentialStoreFailure(error);
				}
			}
			return resolved.authorization;
		});

	const toProviderChatRequest = (request: ChatRequest): ProviderChatRequest => {
		const providerRequest: {
			-readonly [Key in keyof ProviderChatRequest]: ProviderChatRequest[Key];
		} = { messages: request.messages };
		if (request.cacheRetention !== undefined) {
			providerRequest.cacheRetention = request.cacheRetention;
		}
		if (request.cacheWarming !== undefined) {
			providerRequest.cacheWarming = request.cacheWarming;
		}
		if (request.maxOutputTokens !== undefined) {
			providerRequest.maxOutputTokens = request.maxOutputTokens;
		}
		if (request.promptCacheKey !== undefined) {
			providerRequest.promptCacheKey = request.promptCacheKey;
		}
		if (request.reasoningEffort !== undefined) {
			providerRequest.reasoningEffort = request.reasoningEffort;
		}
		if (request.system !== undefined) {
			providerRequest.system = request.system;
		}
		if (request.tools !== undefined) {
			providerRequest.tools = request.tools;
		}
		return providerRequest;
	};

	const streamSelectedChat = async function* (
		request: ChatRequest,
		selection: ChatTarget
	): AsyncIterable<ChatEvent> {
		try {
			throwIfAborted(request.signal);
			const authorization = await resolveAuthorization(
				selection.registered.provider,
				request.signal
			);
			throwIfAborted(request.signal);
			const providerRequest = toProviderChatRequest(request);
			let continuation: unknown | undefined;
			for await (const event of selection.registered.provider.streamChat(
				providerRequest,
				{
					authorization,
					model: selection.model,
					signal: request.signal,
				}
			)) {
				throwIfAborted(request.signal);
				if (event.type === "finish") {
					continuation = event.continuation;
					continue;
				}
				yield event;
			}
			throwIfAborted(request.signal);
			yield terminal({
				...(continuation === undefined ? {} : { continuation }),
				status: "success",
			});
		} catch (error) {
			yield terminalForStreamError(error, request);
		}
	};

	const streamChat = async function* (
		request: ChatRequest
	): AsyncIterable<ChatEvent> {
		assertValidMaxOutputTokens(request.maxOutputTokens);
		const selection = selectChatTarget(providers, dynamicModels, request);
		if (selection.kind === "failed") {
			yield terminal({ failure: selection.failure, status: "failure" });
			return;
		}
		yield* streamSelectedChat(request, selection);
	};

	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closePromise !== undefined) {
			return closePromise;
		}
		const closings = [...providers.values()].map(({ provider }) =>
			Promise.resolve().then(() => provider.close?.())
		);
		closePromise = Promise.allSettled(closings).then((results) => {
			const failures = results.flatMap((result) =>
				result.status === "rejected" ? [result.reason] : []
			);
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					"One or more Providers failed to close."
				);
			}
		});
		return closePromise;
	};

	return {
		canEnforceMaxOutputTokens,
		chat: streamChat,
		close,
		deleteCredential: async (providerId) => {
			getRegisteredProvider(providerId);
			await withProviderCredentialLock(providerId, async () => {
				try {
					await credentialStore.delete(providerId);
				} catch (error) {
					throw new ProviderError(
						"provider",
						"Could not delete provider credentials.",
						{
							cause: error,
						}
					);
				}
			});
		},
		getAvailable: async () => {
			const configuredProviders = new Set<string>();
			for (const providerId of providers.keys()) {
				if ((await credentialStore.get(providerId)) !== undefined) {
					configuredProviders.add(providerId);
				}
			}
			return [...configuredProviders].flatMap((providerId) =>
				getProviderModels(providerId)
			);
		},
		getModel: (providerId, modelId) =>
			getProviderModels(providerId).find((model) => model.modelId === modelId),
		getModels: () =>
			[...providers.keys()].flatMap((providerId) =>
				getProviderModels(providerId)
			),
		restoreModels: async () => {
			for (const providerId of providers.keys()) {
				if (restoredProviders.has(providerId)) {
					continue;
				}
				const stored = await modelStore?.get(providerId);
				if (restoredProviders.has(providerId)) {
					continue;
				}
				const restored =
					stored === undefined
						? []
						: validateProviderModels(
								stored,
								providerId,
								"Model store snapshot"
							);
				dynamicModels.set(providerId, restored);
				restoredProviders.add(providerId);
			}
		},
		refreshModels: async (providerId, refreshOptions = {}) => {
			const registered = getRegisteredProvider(providerId);
			const discoverModels = registered.provider.discoverModels;
			if (!discoverModels) {
				throw new Error(
					`Provider ${providerId} does not support model discovery.`
				);
			}
			throwIfAborted(refreshOptions.signal);
			const authorization = await resolveAuthorization(
				registered.provider,
				refreshOptions.signal
			);
			throwIfAborted(refreshOptions.signal);
			const discovered = validateProviderModels(
				await discoverModels({
					authorization,
					signal: refreshOptions.signal,
				}),
				providerId,
				"Provider discovery"
			);
			throwIfAborted(refreshOptions.signal);
			if (modelStore) {
				await modelStore.set(providerId, discovered, {
					signal: refreshOptions.signal,
				});
			}
			dynamicModels.set(providerId, discovered);
			restoredProviders.add(providerId);
			return getProviderModels(providerId);
		},
		register: (provider) => {
			if (closePromise !== undefined) {
				throw new Error("ProviderCollection is closed.");
			}
			if (providers.has(provider.id)) {
				throw new Error(`Provider already registered: ${provider.id}`);
			}
			if (provider.id.trim().length === 0) {
				throw new Error("Provider ID must not be empty.");
			}
			const models: ProviderModel[] = [];
			const modelIds = new Set<string>();
			for (const candidate of provider.models) {
				if (
					!isProviderModel(candidate) ||
					candidate.providerId !== provider.id ||
					candidate.modelId.trim().length === 0 ||
					candidate.protocolId.trim().length === 0
				) {
					throw new Error(
						`Invalid model identity for provider ${provider.id}.`
					);
				}
				if (modelIds.has(candidate.modelId)) {
					throw new Error(
						`Duplicate model ID for provider ${provider.id}: ${candidate.modelId}`
					);
				}
				modelIds.add(candidate.modelId);
				models.push(normalizeProviderModel(candidate));
			}
			providers.set(provider.id, {
				models,
				provider,
			});
		},
		setCredential: async (providerId, credential) => {
			getRegisteredProvider(providerId);
			await withProviderCredentialLock(providerId, async () => {
				try {
					await credentialStore.set(providerId, credential);
				} catch (error) {
					throw new ProviderError(
						"provider",
						"Could not save provider credentials.",
						{
							cause: error,
						}
					);
				}
			});
		},
	};
};

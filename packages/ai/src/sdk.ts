import { z } from "zod";
import {
	type ModelPromptCacheCapabilities,
	modelMetadataEntrySchema,
	type SupportedPromptCacheRetentionTier,
	supportedPromptCacheRetentionTierIds,
} from "./model-metadata.ts";
import { type ThinkingLevel, thinkingLevelIds } from "./thinking-level.ts";

export type { SupportedPromptCacheRetentionTier } from "./model-metadata.ts";
export type {
	PromptCachePolicy,
	ResolvedPromptCacheControls,
} from "./prompt-cache-policy.ts";
export {
	DEFAULT_PROMPT_CACHE_POLICY,
	promptCachePolicySchema,
	resolvePromptCacheControls,
} from "./prompt-cache-policy.ts";
export type { ThinkingLevel, ThinkingSelection } from "./thinking-level.ts";
export { thinkingLevelIds, thinkingLevelSchema } from "./thinking-level.ts";

export const providerModelCapabilityIds = [
	"file",
	"image",
	"reasoning",
	"text",
	"tools",
] as const;
export type ProviderModelCapability =
	(typeof providerModelCapabilityIds)[number];

/** Provider-neutral identity used in Session, Agent, and Plugin selections. */
export type ProviderModelSelection = Readonly<{
	modelId: string;
	providerId: string;
}>;

/** Header overrides; names are case-insensitive and null removes a lower-level value. */
export type ProviderHeaders = Readonly<Record<string, string | null>>;

const nonEmptyProviderIdentity = z
	.string()
	.refine((value) => value.trim().length > 0);

/** Validates exact Provider Model identities without a Catalog allowlist. */
export const providerModelSelectionSchema = z
	.object({
		modelId: nonEmptyProviderIdentity,
		providerId: nonEmptyProviderIdentity,
	})
	.strict();

/** Parses a persisted `<providerId>/<modelId>` identity without normalizing either ID. */
export const parseProviderModelSelection = (
	value: string
): ProviderModelSelection | null => {
	const separatorIndex = value.indexOf("/");
	if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
		return null;
	}
	const parsed = providerModelSelectionSchema.safeParse({
		modelId: value.slice(separatorIndex + 1),
		providerId: value.slice(0, separatorIndex),
	});
	return parsed.success ? parsed.data : null;
};

/** A provider-owned model; optional metadata is preserved rather than inferred. */
export type ProviderModel = Readonly<{
	/** Per-model HTTP header overrides applied after provider defaults. */
	headers?: ProviderHeaders;
	/** When present, unsupported image/file/tool inputs fail before provider dispatch. */
	capabilities?: readonly ProviderModelCapability[];
	/** Exact provider-specific cache controls verified for this model. */
	promptCache?: ModelPromptCacheCapabilities;
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
	reasoningEfforts?: readonly ThinkingLevel[];
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

export type ChatRequest = Readonly<{
	cacheRetention?: SupportedPromptCacheRetentionTier;
	cacheWarming?: true;
	headers?: ProviderHeaders;
	/** Returned entries override the merged headers; null removes a header. */
	transformHeaders?: (
		headers: Readonly<Record<string, string>>
	) => ProviderHeaders | Promise<ProviderHeaders>;
	maxOutputTokens?: number;
	messages: readonly ChatMessage[];
	modelId: string;
	promptCacheKey?: string;
	providerId: string;
	reasoningEffort?: ThinkingLevel;
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
	/** Authorization-derived HTTP headers for the collection-owned request pipeline. */
	headers?: ProviderHeaders;
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

export type ProviderChatHeaderContext = Readonly<{
	authorization: unknown;
	model: ProviderModel;
	signal?: AbortSignal;
}>;

/** Finalized non-null headers and request authorization passed to chat dispatch. */
export type ProviderChatContext = ProviderChatHeaderContext &
	Readonly<{
		headers: Readonly<Record<string, string>>;
	}>;

/** Authorization and cancellation passed to provider-owned model discovery. */
export type ProviderModelDiscoveryContext = Readonly<{
	authorization: unknown;
	signal?: AbortSignal;
}>;

export type CredentialMetadata = Readonly<{
	providerId: string;
	type: string;
}>;

export type CredentialStoreOptions = Readonly<{ signal?: AbortSignal }>;

/** Non-secret result of a provider-owned lifecycle operation. */
export type ProviderLifecycleFailure = Readonly<{
	code:
		| "authentication"
		| "credential-store"
		| "oauth-refresh"
		| "provider"
		| "transport";
	message: string;
}>;

export type ProviderAuth = Readonly<{
	authorization: unknown;
	headers?: Readonly<Record<string, string>>;
	source: "stored-credential";
}>;

export type ProviderAuthCheckResult =
	| Readonly<{ source: "stored-credential"; status: "configured" }>
	| Readonly<{ status: "missing" | "invalid" | "aborted" }>
	| Readonly<{ failure: ProviderLifecycleFailure; status: "error" }>;

export type ProviderAuthVerificationResult =
	| Readonly<{ source: "stored-credential"; status: "verified" }>
	| Readonly<{ status: "unsupported" | "missing" | "invalid" | "aborted" }>
	| Readonly<{ failure: ProviderLifecycleFailure; status: "error" }>;

export type ProviderLoginOptions = Readonly<{
	credential?: unknown;
	methodId: string;
	options?: unknown;
	signal?: AbortSignal;
}>;

export type ProviderLoginResult =
	| Readonly<{ status: "saved" }>
	| Readonly<{ status: "unsupported" | "cancelled" }>
	| Readonly<{ failure: ProviderLifecycleFailure; status: "error" }>;

export type ProviderLogoutResult =
	| Readonly<{ status: "logged-out" | "aborted" }>
	| Readonly<{ failure: ProviderLifecycleFailure; status: "error" }>;

/** A registered provider owns its authorization lifecycle, model list, and wire behavior. */
export type Provider = Readonly<{
	/** Shared HTTP header overrides applied after protocol and authorization headers. */
	headers?: ProviderHeaders;
	id: string;
	/** Static baseline models remain available alongside discovered models. */
	models: readonly ProviderModel[];
	/** Return current dynamic models; rejection or cancellation preserves the last-known list. */
	discoverModels?: (
		context: ProviderModelDiscoveryContext
	) => readonly ProviderModel[] | Promise<readonly ProviderModel[]>;
	/** Inspect local credential configuration without refreshing or contacting upstream. */
	checkAuth?: (
		input: Readonly<{ credential: unknown; signal?: AbortSignal }>
	) => boolean | Promise<boolean>;
	/** Return null when not configured; after refresh starts, return any rotation despite caller cancellation so the store can persist it. */
	resolveAuthorization: (
		input: Readonly<{
			credential: unknown | undefined;
			model?: ProviderModel;
			signal?: AbortSignal;
		}>
	) => ProviderAuthorization | null | Promise<ProviderAuthorization | null>;
	/** Explicit, provider-owned remote credential check; never inferred from chat. */
	verifyAuth?: (
		input: Readonly<{
			authorization: unknown;
			model?: ProviderModel;
			signal?: AbortSignal;
		}>
	) => undefined | "unsupported" | Promise<undefined | "unsupported">;
	/** Explicit provider-owned login interaction; undefined means cancelled. */
	login?: (
		options: ProviderLoginOptions
	) => unknown | undefined | Promise<unknown | undefined>;
	/** Supplies protocol and authorization headers before the collection transform. */
	getChatHeaders?: (
		context: ProviderChatHeaderContext
	) => ProviderHeaders | Promise<ProviderHeaders>;
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

/** Application-owned, atomic persistence for SDK Provider credentials. */
export type CredentialStore = Readonly<{
	delete: (
		providerId: string,
		options?: CredentialStoreOptions
	) => void | Promise<void>;
	/** Lists non-secret provider/type metadata without resolving credential values. */
	list: (
		options?: CredentialStoreOptions
	) => readonly CredentialMetadata[] | Promise<readonly CredentialMetadata[]>;
	/** Serializes the read-modify-write callback; once it starts, persist its replacement even if the caller cancels. */
	modify: (
		providerId: string,
		update: (
			credential: unknown | undefined
		) => unknown | undefined | Promise<unknown | undefined>,
		options?: CredentialStoreOptions
	) => unknown | undefined | Promise<unknown | undefined>;
	read: (
		providerId: string,
		options?: CredentialStoreOptions
	) => unknown | undefined | Promise<unknown | undefined>;
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
	/** Provider IDs to refresh; omitted means every registered provider with discovery. */
	providerIds?: readonly string[];
	signal?: AbortSignal;
}>;

export type RefreshModelsResult = Readonly<{
	/** True when the caller's signal aborted the refresh operation. */
	aborted: boolean;
	/** Failures keyed by provider ID; a provider failure does not stop other refreshes. */
	errors: ReadonlyMap<string, Error>;
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
			code:
				| "authentication"
				| "credential-store"
				| "oauth-refresh"
				| "provider"
				| "transport";
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
	| "credential-store"
	| "oauth-refresh"
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
	/** Checks stored authorization configuration without refreshing or contacting upstream. */
	checkAuth: (
		providerId: string,
		options?: CredentialStoreOptions
	) => Promise<ProviderAuthCheckResult>;
	/** Resolves request-scoped authorization; undefined means no usable stored credential. */
	getAuth: (
		provider: string | ProviderModel,
		options?: CredentialStoreOptions
	) => Promise<ProviderAuth | undefined>;
	/** Explicitly asks a provider to verify credentials when it has a safe endpoint. */
	verifyAuth: (
		provider: string | ProviderModel,
		options?: CredentialStoreOptions
	) => Promise<ProviderAuthVerificationResult>;
	/** Explicit login; credential input is stored only in this provider's owner-scoped slot. */
	login: (
		providerId: string,
		options: ProviderLoginOptions
	) => Promise<ProviderLoginResult>;
	/** Removes the stored SDK credential without revoking upstream or ambient auth. */
	logout: (
		providerId: string,
		options?: CredentialStoreOptions
	) => Promise<ProviderLogoutResult>;
	/** Known models whose provider has a stored credential; this does not contact the provider. */
	getAvailable: (providerId?: string) => Promise<readonly ProviderModel[]>;
	/** Registered provider IDs with stored credentials; this does not contact the provider. */
	getConfiguredProviderIds: () => Promise<readonly string[]>;
	getModel: (providerId: string, modelId: string) => ProviderModel | undefined;
	/** Returns in-memory last-known models. Restore the store before listing a fresh instance. */
	getModels: () => readonly ProviderModel[];
	/** Loads persisted dynamic models for providers registered so far, without network access. */
	restoreModels: () => Promise<void>;
	/** Refreshes selected dynamic providers concurrently; static providers are skipped. */
	refreshModels: (
		options?: RefreshModelsOptions
	) => Promise<RefreshModelsResult>;
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
	const queues = new Map<string, Promise<void>>();
	const withLock = async <Result>(
		providerId: string,
		operation: () => Result | Promise<Result>,
		signal?: AbortSignal
	): Promise<Result> => {
		throwIfAborted(signal);
		const previous = queues.get(providerId) ?? Promise.resolve();
		const release = Promise.withResolvers<void>();
		const queued = previous.catch(() => undefined).then(() => release.promise);
		queues.set(providerId, queued);
		void queued.then(() => {
			if (queues.get(providerId) === queued) {
				queues.delete(providerId);
			}
		});
		try {
			await awaitWithSignal(previous, signal);
			throwIfAborted(signal);
			return await operation();
		} finally {
			release.resolve();
		}
	};
	return {
		async delete(providerId, { signal } = {}) {
			await withLock(
				providerId,
				() => {
					credentials.delete(providerId);
				},
				signal
			);
		},
		async list({ signal } = {}) {
			throwIfAborted(signal);
			return [...credentials.entries()].map(([providerId, credential]) => ({
				providerId,
				type: credentialTypeFor(credential),
			}));
		},
		modify: (providerId, update, { signal } = {}) =>
			withLock(
				providerId,
				async () => {
					const current = credentials.get(providerId);
					const replacement = await update(current);
					if (replacement !== undefined) {
						credentials.set(providerId, replacement);
					}
					return credentials.get(providerId);
				},
				signal
			),
		read: (providerId, { signal } = {}) =>
			withLock(providerId, () => credentials.get(providerId), signal),
	};
};

const credentialTypeFor = (credential: unknown): string =>
	isRecord(credential) && typeof credential.kind === "string"
		? credential.kind
		: "unknown";

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

const mergeProviderHeaders = (
	...layers: readonly (ProviderHeaders | undefined)[]
): Readonly<Record<string, string>> => {
	const headers = new Map<string, Readonly<{ name: string; value: string }>>();
	for (const layer of layers) {
		if (layer === undefined) {
			continue;
		}
		for (const [name, value] of Object.entries(layer)) {
			if (value !== null && typeof value !== "string") {
				throw new TypeError("Provider headers must contain strings or null.");
			}
			const normalizedName = name.toLowerCase();
			if (value === null) {
				headers.delete(normalizedName);
			} else {
				headers.set(normalizedName, { name, value });
			}
		}
	}
	return Object.fromEntries(
		[...headers.values()].map(({ name, value }) => [name, value])
	);
};

const isAbortError = (error: unknown): boolean =>
	error instanceof Error && error.name === "AbortError";

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("Aborted", "AbortError");
	}
};

const awaitWithSignal = async <Result>(
	operation: Promise<Result>,
	signal: AbortSignal | undefined
): Promise<Result> => {
	throwIfAborted(signal);
	if (signal === undefined) {
		return operation;
	}
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => {
		aborted.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([operation, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
};

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

const THINKING_LEVELS: readonly ThinkingLevel[] = thinkingLevelIds;
const PROMPT_CACHE_RETENTION_TIERS: readonly SupportedPromptCacheRetentionTier[] =
	supportedPromptCacheRetentionTierIds;
const PROVIDER_MODEL_CAPABILITIES: readonly ProviderModelCapability[] =
	providerModelCapabilityIds;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalProviderHeaders = (value: unknown): boolean =>
	value === undefined ||
	(isRecord(value) &&
		Object.values(value).every(
			(header) => typeof header === "string" || header === null
		));

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

const isOptionalProviderModelPromptCache = (value: unknown): boolean =>
	value === undefined ||
	modelMetadataEntrySchema.safeParse({ promptCache: value }).success;

const isProviderModel = (value: unknown): value is ProviderModel =>
	isRecord(value) &&
	isNonEmptyString(value.providerId) &&
	isNonEmptyString(value.modelId) &&
	isNonEmptyString(value.protocolId) &&
	isOptionalProviderHeaders(value.headers) &&
	isOptionalStringArrayOf(value.capabilities, PROVIDER_MODEL_CAPABILITIES) &&
	isOptionalStringArrayOf(value.reasoningEfforts, THINKING_LEVELS) &&
	isOptionalStringArrayOf(
		value.promptCacheRetentionTiers,
		PROMPT_CACHE_RETENTION_TIERS
	) &&
	isOptionalPromptCacheRetentionTtlRecord(value.promptCacheRetentionTtlMs) &&
	isOptionalProviderModelPromptCache(value.promptCache) &&
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

const lifecycleFailureForError = (error: unknown): ProviderLifecycleFailure => {
	if (isCredentialStoreFailure(error)) {
		return {
			code: "credential-store",
			message: "Provider credential storage operation failed.",
		};
	}
	if (error instanceof ProviderError) {
		return {
			code: error.code === "unsupported-capability" ? "provider" : error.code,
			message: "Provider authentication operation failed.",
		};
	}
	return {
		code: "provider",
		message: "Provider authentication operation failed.",
	};
};

const failureForError = (
	error: unknown,
	providerId: string,
	modelId: string
): ChatFailure => {
	if (isCredentialStoreFailure(error)) {
		return {
			code: "credential-store",
			message: "Provider credential storage operation failed.",
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
		let credential: unknown | undefined;
		try {
			credential = await credentialStore.read(providerId);
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
	};

	const resolveProviderAuth = async (
		provider: Provider,
		model: ProviderModel | undefined,
		signal: AbortSignal | undefined
	): Promise<ProviderAuth | undefined> => {
		let resolved: ProviderAuthorization | null | undefined;
		let resolverFailed = false;
		const modification = Promise.resolve()
			.then(() =>
				credentialStore.modify(
					provider.id,
					async (credential) => {
						throwIfAborted(signal);
						try {
							resolved = await provider.resolveAuthorization({
								credential,
								model,
								signal,
							});
						} catch (error) {
							resolverFailed = true;
							if (signal?.aborted || isAbortError(error)) {
								throw error;
							}
							const failure = lifecycleFailureForError(error);
							throw new ProviderError(failure.code, failure.message);
						}
						return resolved?.credential;
					},
					{ signal }
				)
			)
			.catch((error: unknown) => {
				if (resolverFailed || signal?.aborted || isAbortError(error)) {
					throw error;
				}
				throw credentialStoreFailure(error);
			});
		await awaitWithSignal(modification, signal);
		throwIfAborted(signal);
		if (resolved == null) {
			return;
		}
		return {
			authorization: resolved.authorization,
			...(resolved.headers === undefined
				? {}
				: { headers: mergeProviderHeaders(resolved.headers) }),
			source: "stored-credential",
		};
	};

	const resolveAuthorization = async (
		provider: Provider,
		model: ProviderModel | undefined,
		signal: AbortSignal | undefined
	): Promise<ProviderAuth> => {
		const resolved = await resolveProviderAuth(provider, model, signal);
		if (resolved === undefined) {
			throw new ProviderError(
				"authentication",
				`Provider ${provider.id} has no usable credentials.`
			);
		}
		return resolved;
	};

	const providerAuthTargetFor = (
		provider: string | ProviderModel
	): Readonly<{ model?: ProviderModel; provider: Provider }> => {
		const providerId =
			typeof provider === "string" ? provider : provider.providerId;
		const registered = providers.get(providerId);
		if (registered === undefined) {
			throw new ProviderError("provider", `Unknown provider: ${providerId}`);
		}
		if (typeof provider === "string") {
			return { provider: registered.provider };
		}
		const model = getProviderModels(providerId).find(
			(candidate) => candidate.modelId === provider.modelId
		);
		if (model === undefined) {
			throw new ProviderError(
				"provider",
				`Unknown Provider Model: ${providerId}/${provider.modelId}`
			);
		}
		return { model, provider: registered.provider };
	};

	const readCredentialForCheck = async (
		providerId: string,
		signal: AbortSignal | undefined
	): Promise<Readonly<{ credential?: unknown; error?: unknown }>> => {
		try {
			return { credential: await credentialStore.read(providerId, { signal }) };
		} catch (error) {
			return { error };
		}
	};

	const checkStoredCredential = async (
		provider: Provider,
		credential: unknown,
		signal: AbortSignal | undefined
	): Promise<ProviderAuthCheckResult> => {
		try {
			const configured =
				(await provider.checkAuth?.({ credential, signal })) ?? true;
			if (signal?.aborted) {
				return { status: "aborted" };
			}
			return configured
				? { source: "stored-credential", status: "configured" }
				: { status: "invalid" };
		} catch (error) {
			return signal?.aborted || isAbortError(error)
				? { status: "aborted" }
				: { failure: lifecycleFailureForError(error), status: "error" };
		}
	};

	const checkAuth = async (
		providerId: string,
		{ signal }: CredentialStoreOptions = {}
	): Promise<ProviderAuthCheckResult> => {
		const registered = providers.get(providerId);
		if (registered === undefined) {
			return {
				failure: {
					code: "provider",
					message: `Unknown provider: ${providerId}`,
				},
				status: "error",
			};
		}
		if (signal?.aborted) {
			return { status: "aborted" };
		}
		const readResult = await readCredentialForCheck(providerId, signal);
		if ("error" in readResult) {
			return signal?.aborted || isAbortError(readResult.error)
				? { status: "aborted" }
				: {
						failure: {
							code: "credential-store",
							message: "Provider credentials could not be read.",
						},
						status: "error",
					};
		}
		if (signal?.aborted) {
			return { status: "aborted" };
		}
		if (readResult.credential === undefined) {
			return { status: "missing" };
		}
		return checkStoredCredential(
			registered.provider,
			readResult.credential,
			signal
		);
	};

	const getAuth = async (
		providerInput: string | ProviderModel,
		{ signal }: CredentialStoreOptions = {}
	): Promise<ProviderAuth | undefined> => {
		const target = providerAuthTargetFor(providerInput);
		try {
			const auth = await resolveProviderAuth(
				target.provider,
				target.model,
				signal
			);
			if (auth === undefined || target.model?.headers === undefined) {
				return auth;
			}
			return {
				...auth,
				headers: mergeProviderHeaders(auth.headers, target.model.headers),
			};
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) {
				throw error;
			}
			const failure = lifecycleFailureForError(error);
			throw new ProviderError(failure.code, failure.message);
		}
	};

	const verifyConfiguredProvider = async (
		target: Readonly<{ model?: ProviderModel; provider: Provider }>,
		signal: AbortSignal | undefined
	): Promise<ProviderAuthVerificationResult> => {
		const verifyProviderAuth = target.provider.verifyAuth;
		if (verifyProviderAuth === undefined) {
			return { status: "unsupported" };
		}
		try {
			const auth = await resolveProviderAuth(
				target.provider,
				target.model,
				signal
			);
			if (signal?.aborted) {
				return { status: "aborted" };
			}
			if (auth === undefined) {
				return { status: "invalid" };
			}
			const result = await verifyProviderAuth({
				authorization: auth.authorization,
				model: target.model,
				signal,
			});
			if (signal?.aborted) {
				return { status: "aborted" };
			}
			return result === "unsupported"
				? { status: "unsupported" }
				: { source: auth.source, status: "verified" };
		} catch (error) {
			return signal?.aborted || isAbortError(error)
				? { status: "aborted" }
				: { failure: lifecycleFailureForError(error), status: "error" };
		}
	};

	const verifyAuth = async (
		providerInput: string | ProviderModel,
		{ signal }: CredentialStoreOptions = {}
	): Promise<ProviderAuthVerificationResult> => {
		let target: Readonly<{ model?: ProviderModel; provider: Provider }>;
		try {
			target = providerAuthTargetFor(providerInput);
		} catch (error) {
			return { failure: lifecycleFailureForError(error), status: "error" };
		}
		const configuration = await checkAuth(target.provider.id, { signal });
		if (configuration.status === "error") {
			return configuration;
		}
		if (configuration.status !== "configured") {
			return { status: configuration.status };
		}
		return verifyConfiguredProvider(target, signal);
	};

	const acquireLoginCredential = async (
		provider: Provider,
		loginOptions: ProviderLoginOptions
	): Promise<
		| Readonly<{ credential: unknown }>
		| Readonly<{ result: ProviderLoginResult }>
	> => {
		if (loginOptions.signal?.aborted) {
			return { result: { status: "cancelled" } };
		}
		if (provider.login === undefined) {
			return loginOptions.credential === undefined
				? { result: { status: "unsupported" } }
				: { credential: loginOptions.credential };
		}
		try {
			const credential = await provider.login(loginOptions);
			return loginOptions.signal?.aborted || credential === undefined
				? { result: { status: "cancelled" } }
				: { credential };
		} catch (error) {
			return loginOptions.signal?.aborted || isAbortError(error)
				? { result: { status: "cancelled" } }
				: {
						result: {
							failure: lifecycleFailureForError(error),
							status: "error",
						},
					};
		}
	};

	const saveLoginCredential = async (
		providerId: string,
		credential: unknown,
		signal: AbortSignal | undefined
	): Promise<ProviderLoginResult> => {
		try {
			await credentialStore.modify(providerId, () => credential, { signal });
			return { status: "saved" };
		} catch (error) {
			return signal?.aborted || isAbortError(error)
				? { status: "cancelled" }
				: {
						failure: {
							code: "credential-store",
							message: "Provider credentials could not be saved.",
						},
						status: "error",
					};
		}
	};

	const login = async (
		providerId: string,
		loginOptions: ProviderLoginOptions
	): Promise<ProviderLoginResult> => {
		const registered = providers.get(providerId);
		if (registered === undefined) {
			return {
				failure: {
					code: "provider",
					message: `Unknown provider: ${providerId}`,
				},
				status: "error",
			};
		}
		const loginResult = await acquireLoginCredential(
			registered.provider,
			loginOptions
		);
		if ("result" in loginResult) {
			return loginResult.result;
		}
		return saveLoginCredential(
			providerId,
			loginResult.credential,
			loginOptions.signal
		);
	};

	const logout = async (
		providerId: string,
		{ signal }: CredentialStoreOptions = {}
	): Promise<ProviderLogoutResult> => {
		if (!providers.has(providerId)) {
			return {
				failure: {
					code: "provider",
					message: `Unknown provider: ${providerId}`,
				},
				status: "error",
			};
		}
		try {
			await credentialStore.delete(providerId, { signal });
			return { status: "logged-out" };
		} catch (error) {
			return signal?.aborted || isAbortError(error)
				? { status: "aborted" }
				: {
						failure: {
							code: "credential-store",
							message: "Provider credentials could not be removed.",
						},
						status: "error",
					};
		}
	};

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
			const provider = selection.registered.provider;
			const auth = await resolveAuthorization(
				provider,
				selection.model,
				request.signal
			);
			throwIfAborted(request.signal);
			const headerContext: ProviderChatHeaderContext = {
				authorization: auth.authorization,
				model: selection.model,
				signal: request.signal,
			};
			const protocolHeaders = await provider.getChatHeaders?.(headerContext);
			throwIfAborted(request.signal);
			let headers = mergeProviderHeaders(
				protocolHeaders,
				auth.headers,
				provider.headers,
				selection.model.headers,
				request.headers
			);
			if (request.transformHeaders !== undefined) {
				const transformed = await request.transformHeaders(headers);
				throwIfAborted(request.signal);
				headers = mergeProviderHeaders(headers, transformed);
			}
			const providerRequest = toProviderChatRequest(request);
			let continuation: unknown | undefined;
			for await (const event of provider.streamChat(providerRequest, {
				...headerContext,
				headers,
			})) {
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
			const result = await logout(providerId);
			if (result.status === "error") {
				throw new ProviderError(result.failure.code, result.failure.message);
			}
			if (result.status === "aborted") {
				throw new DOMException("Credential deletion aborted.", "AbortError");
			}
		},
		checkAuth,
		getAuth,
		verifyAuth,
		login,
		logout,
		getAvailable: async (providerId) => {
			const configuredProviders = new Set(
				(await credentialStore.list()).map(({ providerId: id }) => id)
			);
			const providerIds =
				providerId === undefined ? [...providers.keys()] : [providerId];
			return providerIds
				.filter(
					(configuredProviderId) =>
						providers.has(configuredProviderId) &&
						configuredProviders.has(configuredProviderId)
				)
				.flatMap((configuredProviderId) =>
					getProviderModels(configuredProviderId)
				);
		},
		getConfiguredProviderIds: async () => {
			const configuredProviders = new Set(
				(await credentialStore.list()).map(({ providerId }) => providerId)
			);
			return [...providers.keys()].filter((providerId) =>
				configuredProviders.has(providerId)
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
		refreshModels: async (refreshOptions = {}) => {
			const selectedProviderIds =
				refreshOptions.providerIds === undefined
					? undefined
					: new Set(refreshOptions.providerIds);
			const errors = new Map<string, Error>();
			if (refreshOptions.signal?.aborted) {
				return { aborted: true, errors };
			}
			if (selectedProviderIds !== undefined) {
				for (const providerId of selectedProviderIds) {
					if (!providers.has(providerId)) {
						errors.set(
							providerId,
							new Error(`Unknown provider: ${providerId}`)
						);
					}
				}
			}
			const discoverableProviders = [...providers.entries()].filter(
				([providerId, registered]) =>
					registered.provider.discoverModels !== undefined &&
					(selectedProviderIds === undefined ||
						selectedProviderIds.has(providerId))
			);
			await Promise.all(
				discoverableProviders.map(async ([providerId, registered]) => {
					try {
						throwIfAborted(refreshOptions.signal);
						const auth = await resolveAuthorization(
							registered.provider,
							undefined,
							refreshOptions.signal
						);
						throwIfAborted(refreshOptions.signal);
						const discovered = validateProviderModels(
							await registered.provider.discoverModels?.({
								authorization: auth.authorization,
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
					} catch (error) {
						if (!refreshOptions.signal?.aborted) {
							errors.set(
								providerId,
								error instanceof Error ? error : new Error(errorMessage(error))
							);
						}
					}
				})
			);
			return {
				aborted: refreshOptions.signal?.aborted ?? false,
				errors,
			};
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
			if (!isOptionalProviderHeaders(provider.headers)) {
				throw new Error(`Invalid default headers for provider ${provider.id}.`);
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
			try {
				await credentialStore.modify(providerId, () => credential);
			} catch (error) {
				throw new ProviderError(
					"credential-store",
					"Could not save provider credentials.",
					{ cause: error }
				);
			}
		},
	};
};

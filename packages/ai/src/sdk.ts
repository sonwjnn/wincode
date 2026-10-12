export type ProviderModelCapability =
	| "file"
	| "image"
	| "reasoning"
	| "text"
	| "tools";

/** A provider-owned model; optional metadata is preserved rather than inferred. */
export type ProviderModel = Readonly<{
	/** When present, unsupported image/file/tool inputs fail before provider dispatch. */
	capabilities?: readonly ProviderModelCapability[];
	limits?: Readonly<{
		contextWindowTokens?: number;
		maxOutputTokens?: number;
	}>;
	modelId: string;
	pricing?: Readonly<{
		inputPerMillionTokensUsd?: number;
		outputPerMillionTokensUsd?: number;
	}>;
	protocolId: string;
	providerId: string;
}>;

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
	  }>;

export type ChatMessage = Readonly<{
	content: readonly ChatContentPart[];
	role: "assistant" | "tool" | "user";
}>;

export type ChatTool = Readonly<{
	description?: string;
	inputSchema: Readonly<Record<string, unknown>>;
	name: string;
}>;

export type ChatRequest = Readonly<{
	cacheRetention?: "long" | "short";
	messages: readonly ChatMessage[];
	modelId: string;
	providerId: string;
	signal?: AbortSignal;
	system?: string;
	tools?: readonly ChatTool[];
}>;

export type ProviderChatRequest = Readonly<{
	cacheRetention?: ChatRequest["cacheRetention"];
	messages: ChatRequest["messages"];
	system?: ChatRequest["system"];
	tools?: ChatRequest["tools"];
}>;

export type ProviderAuthorization = Readonly<{
	authorization: unknown;
	/** A rotated credential is persisted before the next request resolves auth. */
	credential?: unknown;
}>;

/** Provider output events; the SDK appends the single terminal outcome. */
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
	  }>;

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
}>;

/** Application-owned persistence for one credential per provider ID in this collection. */
export type CredentialStore = Readonly<{
	delete: (providerId: string) => void | Promise<void>;
	get: (
		providerId: string
	) => unknown | undefined | Promise<unknown | undefined>;
	set: (providerId: string, credential: unknown) => void | Promise<void>;
}>;

/** Application-owned persistence for last-successful dynamic discovery results. */
export type ModelStore = Readonly<{
	get: (
		providerId: string
	) =>
		| readonly ProviderModel[]
		| undefined
		| Promise<readonly ProviderModel[] | undefined>;
	set: (
		providerId: string,
		models: readonly ProviderModel[]
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
	| Readonly<{ status: "success" }>
	| Readonly<{ failure: ChatFailure; status: "failure" }>
	| Readonly<{ reason?: string; status: "aborted" }>;

export type ChatEvent =
	| ProviderChatEvent
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

const isProviderModel = (value: unknown): value is ProviderModel => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const model = value as Record<string, unknown>;
	if (
		typeof model.providerId !== "string" ||
		model.providerId.trim().length === 0 ||
		typeof model.modelId !== "string" ||
		model.modelId.trim().length === 0 ||
		typeof model.protocolId !== "string" ||
		model.protocolId.trim().length === 0
	) {
		return false;
	}
	if (
		model.capabilities !== undefined &&
		!(
			Array.isArray(model.capabilities) &&
			model.capabilities.every((capability: unknown) =>
				["file", "image", "reasoning", "text", "tools"].includes(
					String(capability)
				)
			)
		)
	) {
		return false;
	}
	for (const field of ["limits", "pricing"] as const) {
		const metadata = model[field];
		if (metadata === undefined) {
			continue;
		}
		if (typeof metadata !== "object" || metadata === null) {
			return false;
		}
		for (const value of Object.values(metadata)) {
			if (!isNonNegativeFiniteNumber(value)) {
				return false;
			}
		}
	}
	return true;
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
		models.push(candidate);
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
			const providerRequest: ProviderChatRequest = {
				cacheRetention: request.cacheRetention,
				messages: request.messages,
				system: request.system,
				tools: request.tools,
			};
			for await (const event of selection.registered.provider.streamChat(
				providerRequest,
				{
					authorization,
					model: selection.model,
					signal: request.signal,
				}
			)) {
				throwIfAborted(request.signal);
				yield event;
			}
			throwIfAborted(request.signal);
			yield terminal({ status: "success" });
		} catch (error) {
			yield terminalForStreamError(error, request);
		}
	};

	const streamChat = async function* (
		request: ChatRequest
	): AsyncIterable<ChatEvent> {
		const selection = selectChatTarget(providers, dynamicModels, request);
		if (selection.kind === "failed") {
			yield terminal({ failure: selection.failure, status: "failure" });
			return;
		}
		yield* streamSelectedChat(request, selection);
	};

	return {
		chat: streamChat,
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
				await modelStore.set(providerId, discovered);
			}
			dynamicModels.set(providerId, discovered);
			restoredProviders.add(providerId);
			return getProviderModels(providerId);
		},
		register: (provider) => {
			if (providers.has(provider.id)) {
				throw new Error(`Provider already registered: ${provider.id}`);
			}
			if (provider.id.trim().length === 0) {
				throw new Error("Provider ID must not be empty.");
			}
			const modelIds = new Set<string>();
			for (const model of provider.models) {
				if (
					model.providerId !== provider.id ||
					model.modelId.trim().length === 0 ||
					model.protocolId.trim().length === 0
				) {
					throw new Error(
						`Invalid model identity for provider ${provider.id}.`
					);
				}
				if (modelIds.has(model.modelId)) {
					throw new Error(
						`Duplicate model ID for provider ${provider.id}: ${model.modelId}`
					);
				}
				modelIds.add(model.modelId);
			}
			providers.set(provider.id, {
				models: [...provider.models],
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

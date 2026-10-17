import type { OpenAIBrowserLoginOptions, OpenAIProvider } from "@wincode/ai";
import {
	type CredentialStore,
	createProviderCollection,
	type ModelStore,
	type Provider,
	type ProviderCollection,
	type ProviderModel,
} from "@wincode/ai";
import type {
	PluginProviderDescriptor,
	PluginRuntime,
} from "@/modules/plugins/runtime";
import {
	BUILT_IN_PROVIDER_CATALOG,
	type BuiltInProviderFactoryOptions,
	isBuiltInProviderId,
	OPENAI_PROVIDER_ID,
} from "@/modules/providers/built-in-provider-catalog";
import type { PluginProviderComposition } from "@/modules/providers/interactive-provider-controller";
import { pluginProviderIdentityMatches } from "@/modules/providers/provider-model-selection";
import {
	getProviderSdkStores,
	pluginProviderStorageId,
} from "@/modules/providers/provider-stores";
import type { SessionSdkPluginProviderSource } from "./plugin-provider-source";

export const createDefaultSessionProviderCollection = (
	pluginRuntime?: PluginRuntime,
	sessionId?: string,
	options: Omit<
		InteractiveSessionProviderCollectionOptions,
		"pluginProviders" | "sessionId"
	> &
		Readonly<{
			allowedPluginProviderIds?: readonly string[];
			allowedPluginProviderSources?: readonly SessionSdkPluginProviderSource[];
		}> = {}
): Promise<InteractiveSessionProviderCollection> => {
	const {
		allowedPluginProviderIds,
		allowedPluginProviderSources,
		...collectionOptions
	} = options;
	return createInteractiveSessionProviderCollection({
		...collectionOptions,
		...(sessionId === undefined ? {} : { sessionId }),
		pluginProviders: pluginProvidersFromRuntime(
			pluginRuntime,
			sessionId,
			allowedPluginProviderIds,
			allowedPluginProviderSources
		),
	});
};

export type InteractiveSessionProviderCollectionOptions =
	BuiltInProviderFactoryOptions &
		Readonly<{
			credentialStore?: CredentialStore;
			modelStore?: ModelStore;
			pluginProviders?: readonly PluginProviderDescriptor[];
			userDataDir?: string;
		}>;

export type PreparedProviderComposition = Readonly<{
	commit: () => Promise<void>;
	discard: () => Promise<void>;
}>;

export type SessionProviderCollectionFactory = (
	pluginRuntime?: PluginRuntime,
	sessionId?: string,
	allowedPluginProviderIds?: readonly string[],
	allowedPluginProviderSources?: readonly SessionSdkPluginProviderSource[]
) => ProviderCollection | undefined | Promise<ProviderCollection | undefined>;

/** Thrown when a Session Host cannot obtain a ProviderCollection. */
export class ProviderCollectionUnavailableError extends Error {
	constructor() {
		super(
			"Session Host could not be initialized because its ProviderCollection is unavailable."
		);
		this.name = "ProviderCollectionUnavailableError";
	}
}

export type InteractiveSessionProviderCollection = ProviderCollection &
	Readonly<{
		getPluginProviderComposition: (
			providerId: string
		) => PluginProviderComposition | undefined;
		getPluginProviderRegistrations: () => readonly PluginProviderDescriptor[];
		getDiscoverableProviderIds: () => readonly string[];
		getCompositionRevision: () => number;
		subscribeComposition: (listener: () => void) => () => void;
		supportsModelDiscovery: (providerId: string) => boolean;
		preparePluginProviderRegistrations: (
			registrations: readonly PluginProviderDescriptor[]
		) => Promise<PreparedProviderComposition>;
		failClosed: () => Promise<void>;
		loginOpenAIOAuth: (
			options?: OpenAIBrowserLoginOptions
		) => Promise<readonly ProviderModel[]>;
	}>;

type PluginProviderRegistrationsSource = Readonly<{
	getPluginProviderRegistrations?: () => readonly PluginProviderDescriptor[];
}>;

const hasPluginProviderRegistrations = (
	providerCollection: ProviderCollection | PluginProviderRegistrationsSource
): providerCollection is Required<PluginProviderRegistrationsSource> =>
	"getPluginProviderRegistrations" in providerCollection &&
	typeof providerCollection.getPluginProviderRegistrations === "function";

/** Reads authoritative Plugin ownership metadata when the Host collection exposes it. */
export const getPluginProviderRegistrationsFromCollection = (
	providerCollection:
		| ProviderCollection
		| PluginProviderRegistrationsSource
		| undefined
): readonly PluginProviderDescriptor[] | undefined => {
	if (
		providerCollection === undefined ||
		!hasPluginProviderRegistrations(providerCollection)
	) {
		return;
	}
	return providerCollection.getPluginProviderRegistrations();
};

type ProviderCollectionBackend = Readonly<{
	collection: ProviderCollection;
	openAIProvider: OpenAIProvider | undefined;
	pluginProviders: readonly PluginProviderDescriptor[];
	discoverableProviderIds: Set<string>;
	storageIds: Map<string, string>;
}>;

const createFailClosedBackend = (): ProviderCollectionBackend =>
	Object.freeze({
		collection: createProviderCollection({
			credentialStore: {
				delete: () => undefined,
				get: () => undefined,
				set: () => undefined,
			},
			modelStore: {
				get: () => undefined,
				set: () => undefined,
			},
		}),
		discoverableProviderIds: new Set<string>(),
		openAIProvider: undefined,
		pluginProviders: Object.freeze([]),
		storageIds: new Map<string, string>(),
	});

const closeProviderInstances = async (
	providers: readonly Provider[]
): Promise<void> => {
	await Promise.allSettled(
		providers.map((provider) =>
			Promise.resolve().then(() => provider.close?.())
		)
	);
};

const registerBuiltInProviders = (
	options: BuiltInProviderFactoryOptions,
	addBuiltInProvider: (provider: Provider) => void
): OpenAIProvider => {
	const openAIProvider =
		BUILT_IN_PROVIDER_CATALOG[OPENAI_PROVIDER_ID].createProvider(options);
	addBuiltInProvider(openAIProvider);
	for (const [providerId, definition] of Object.entries(
		BUILT_IN_PROVIDER_CATALOG
	)) {
		if (providerId === OPENAI_PROVIDER_ID) {
			continue;
		}
		addBuiltInProvider(definition.createProvider(options));
	}
	return openAIProvider;
};

const createProviderBackend = async (
	options: InteractiveSessionProviderCollectionOptions,
	pluginProviders: readonly PluginProviderDescriptor[]
): Promise<ProviderCollectionBackend> => {
	const providers: Provider[] = [];
	const storageIds = new Map<string, string>();
	const addProvider = (provider: Provider, storageId = provider.id): void => {
		providers.push(provider);
		if (storageIds.has(provider.id)) {
			throw new Error(`Duplicate Provider ID '${provider.id}'.`);
		}
		storageIds.set(provider.id, storageId);
	};
	const addBuiltInProvider = (provider: Provider): void => {
		if (!isBuiltInProviderId(provider.id)) {
			throw new Error(`Unknown built-in Provider ID '${provider.id}'.`);
		}
		addProvider(provider);
	};
	let openAIProvider: OpenAIProvider;
	try {
		openAIProvider = registerBuiltInProviders(options, addBuiltInProvider);
		for (const registration of pluginProviders) {
			if (isBuiltInProviderId(registration.providerId)) {
				throw new Error(`Duplicate Provider ID '${registration.providerId}'.`);
			}
			let provider: Provider;
			try {
				provider = registration.createProvider();
			} catch {
				throw new Error(
					`Plugin Provider '${registration.providerId}' could not be created.`
				);
			}
			if (typeof provider !== "object" || provider === null) {
				throw new Error(
					`Plugin Provider factory for '${registration.providerId}' returned an invalid Provider.`
				);
			}
			if (provider.id !== registration.providerId) {
				providers.push(provider);
				throw new Error(
					`Plugin Provider factory for '${registration.providerId}' returned a different Provider ID.`
				);
			}
			addProvider(
				provider,
				pluginProviderStorageId({
					pluginId: registration.pluginId,
					providerId: registration.providerId,
					sourceIdentity: registration.sourceIdentity,
				})
			);
		}
	} catch (error) {
		await closeProviderInstances(providers);
		throw error;
	}

	let backingCredentials: CredentialStore;
	let backingModels: ModelStore;
	try {
		const defaultStores =
			options.credentialStore === undefined || options.modelStore === undefined
				? getProviderSdkStores({ userDataDir: options.userDataDir })
				: {
						credentialStore: options.credentialStore,
						modelStore: options.modelStore,
					};
		backingCredentials =
			options.credentialStore ?? defaultStores.credentialStore;
		backingModels = options.modelStore ?? defaultStores.modelStore;
	} catch (error) {
		await closeProviderInstances(providers);
		throw error;
	}
	const storageIdFor = (providerId: string): string => {
		const storageId = storageIds.get(providerId);
		if (storageId === undefined) {
			throw new Error("Provider storage owner is not registered.");
		}
		return storageId;
	};
	const credentialStore: CredentialStore = Object.freeze({
		delete: (providerId) => backingCredentials.delete(storageIdFor(providerId)),
		get: (providerId) => backingCredentials.get(storageIdFor(providerId)),
		set: (providerId, credential) =>
			backingCredentials.set(storageIdFor(providerId), credential),
	});
	const modelStore: ModelStore = Object.freeze({
		get: (providerId) => backingModels.get(storageIdFor(providerId)),
		set: (providerId, models, writeOptions) =>
			backingModels.set(storageIdFor(providerId), models, writeOptions),
	});
	let collection: ProviderCollection;
	try {
		collection = createProviderCollection({ credentialStore, modelStore });
		for (const provider of providers) {
			collection.register(provider);
		}
	} catch (error) {
		await closeProviderInstances(providers);
		throw error;
	}
	return Object.freeze({
		collection,
		discoverableProviderIds: new Set(
			providers.flatMap((provider) =>
				provider.discoverModels === undefined ? [] : [provider.id]
			)
		),
		openAIProvider,
		pluginProviders: Object.freeze([...pluginProviders]),
		storageIds,
	});
};

/** Creates fresh Provider SDK instances and owner-scoped stores for one Session Host. */
export const createInteractiveSessionProviderCollection = async (
	options: InteractiveSessionProviderCollectionOptions = {}
): Promise<InteractiveSessionProviderCollection> => {
	let backend = await createProviderBackend(
		options,
		options.pluginProviders ?? []
	);
	let closePromise: Promise<void> | undefined;
	let compositionRevision = 0;
	const compositionListeners = new Set<() => void>();
	const notifyCompositionChanged = (): void => {
		compositionRevision += 1;
		for (const listener of [...compositionListeners]) {
			try {
				listener();
			} catch {
				// One subscriber cannot interrupt a Provider composition change.
			}
		}
	};
	const activeCollection = (): ProviderCollection => backend.collection;
	const close = (): Promise<void> => {
		if (closePromise !== undefined) {
			return closePromise;
		}
		const previousCollection = activeCollection();
		backend = createFailClosedBackend();
		notifyCompositionChanged();
		closePromise = previousCollection.close();
		return closePromise;
	};
	const interactiveCollection: InteractiveSessionProviderCollection = {
		canEnforceMaxOutputTokens: (providerId, modelId) =>
			activeCollection().canEnforceMaxOutputTokens(providerId, modelId),
		chat: (request) => activeCollection().chat(request),
		close,
		deleteCredential: (providerId) =>
			activeCollection().deleteCredential(providerId),
		getAvailable: (providerId) => activeCollection().getAvailable(providerId),
		getModel: (providerId, modelId) =>
			activeCollection().getModel(providerId, modelId),
		getModels: () => activeCollection().getModels(),
		restoreModels: () => activeCollection().restoreModels(),
		refreshModels: (refreshOptions) =>
			activeCollection().refreshModels(refreshOptions),
		register: (provider) => {
			if (closePromise !== undefined) {
				throw new Error("ProviderCollection is closed.");
			}
			const current = backend;
			if (current.storageIds.has(provider.id)) {
				throw new Error(`Duplicate Provider ID '${provider.id}'.`);
			}
			current.collection.register(provider);
			current.storageIds.set(provider.id, provider.id);
			if (provider.discoverModels !== undefined) {
				current.discoverableProviderIds.add(provider.id);
			}
			notifyCompositionChanged();
		},
		setCredential: (providerId, credential) =>
			activeCollection().setCredential(providerId, credential),
		getPluginProviderComposition(providerId) {
			const current = backend;
			const registration = current.pluginProviders.find(
				(candidate) => candidate.providerId === providerId
			);
			if (registration === undefined) {
				return;
			}
			return Object.freeze({
				providerCollection: current.collection,
				registration,
				supportsModelDiscovery: current.discoverableProviderIds.has(providerId),
			});
		},
		getPluginProviderRegistrations: () => backend.pluginProviders,
		getDiscoverableProviderIds: () =>
			Object.freeze([...backend.discoverableProviderIds]),
		getCompositionRevision: () => compositionRevision,
		subscribeComposition(listener) {
			compositionListeners.add(listener);
			return () => compositionListeners.delete(listener);
		},
		supportsModelDiscovery: (providerId) =>
			backend.discoverableProviderIds.has(providerId),
		failClosed: close,
		async loginOpenAIOAuth(loginOptions = {}) {
			if (closePromise !== undefined) {
				throw new Error("ProviderCollection is closed.");
			}
			const openAIProvider = backend.openAIProvider;
			if (openAIProvider === undefined) {
				throw new Error("OpenAI browser sign-in is unavailable.");
			}
			const credential = await openAIProvider.login(loginOptions);
			if (loginOptions.signal?.aborted) {
				throw (
					loginOptions.signal.reason ??
					new DOMException("Aborted", "AbortError")
				);
			}
			if (closePromise !== undefined) {
				throw new Error("ProviderCollection is closed.");
			}
			await activeCollection().setCredential(OPENAI_PROVIDER_ID, credential);
			return activeCollection()
				.getAvailable(OPENAI_PROVIDER_ID)
				.then((models) =>
					models.filter((model) => model.providerId === OPENAI_PROVIDER_ID)
				);
		},
		async preparePluginProviderRegistrations(registrations) {
			if (closePromise !== undefined) {
				throw new Error("ProviderCollection is closed.");
			}
			const next = await createProviderBackend(options, registrations);
			try {
				await next.collection.restoreModels();
			} catch (error) {
				await next.collection.close().catch(() => undefined);
				throw error;
			}
			let state: "prepared" | "committed" | "discarded" = "prepared";
			return Object.freeze({
				async commit() {
					if (state !== "prepared") {
						return;
					}
					if (closePromise !== undefined) {
						state = "discarded";
						await next.collection.close().catch(() => undefined);
						return;
					}
					const previous = backend;
					backend = next;
					state = "committed";
					notifyCompositionChanged();
					await previous.collection.close().catch(() => undefined);
				},
				async discard() {
					if (state !== "prepared") {
						return;
					}
					state = "discarded";
					await next.collection.close().catch(() => undefined);
				},
			});
		},
	};
	return Object.freeze(interactiveCollection);
};

export const pluginProvidersFromRuntime = (
	pluginRuntime: PluginRuntime | undefined,
	sessionId?: string,
	allowedProviderIds?: readonly string[],
	allowedProviderSources?: readonly SessionSdkPluginProviderSource[]
): readonly PluginProviderDescriptor[] => {
	const providers = pluginRuntime?.getProviderRegistrations(sessionId) ?? [];
	const allowedIds =
		allowedProviderIds === undefined ? undefined : new Set(allowedProviderIds);
	return providers.filter(
		(provider) =>
			(allowedIds === undefined || allowedIds.has(provider.providerId)) &&
			(allowedProviderSources === undefined ||
				allowedProviderSources.some((source) =>
					pluginProviderIdentityMatches(source, provider)
				))
	);
};

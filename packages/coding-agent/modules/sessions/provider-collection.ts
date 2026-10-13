import {
	type CredentialStore,
	createProviderCollection,
	type ModelStore,
	type Provider,
	type ProviderCollection,
} from "@wincode/ai/sdk";
import {
	createOpenRouterProvider,
	type OpenRouterProviderOptions,
} from "@wincode/ai/sdk/providers/openrouter";
import type {
	PluginProviderDescriptor,
	PluginRuntime,
} from "@/modules/plugins/runtime";
import type { PluginProviderComposition } from "@/modules/providers/interactive-provider-controller";
import {
	createProviderSdkCredentialStore,
	createProviderSdkModelStore,
	pluginProviderStorageId,
} from "@/modules/providers/provider-stores";

/** Non-Interactive execution modes stay on their existing runtime in this slice. */
export const createDefaultSessionProviderCollection = ():
	| ProviderCollection
	| undefined => undefined;

export type InteractiveSessionProviderCollectionOptions = Readonly<{
	credentialStore?: CredentialStore;
	modelStore?: ModelStore;
	openRouterProviderOptions?: OpenRouterProviderOptions;
	pluginProviders?: readonly PluginProviderDescriptor[];
	userDataDir?: string;
}>;

export type PreparedProviderComposition = Readonly<{
	commit: () => Promise<void>;
	discard: () => Promise<void>;
}>;

/** A per-Host collection that can replace its idle Provider composition. */
export type InteractiveSessionProviderCollection = ProviderCollection &
	Readonly<{
		getPluginProviderComposition: (
			providerId: string
		) => PluginProviderComposition | undefined;
		getPluginProviderRegistrations: () => readonly PluginProviderDescriptor[];
		getDiscoverableProviderIds: () => readonly string[];
		supportsModelDiscovery: (providerId: string) => boolean;
		preparePluginProviderRegistrations: (
			registrations: readonly PluginProviderDescriptor[]
		) => Promise<PreparedProviderComposition>;
		failClosed: () => Promise<void>;
	}>;

type ProviderCollectionBackend = Readonly<{
	collection: ProviderCollection;
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
		pluginProviders: Object.freeze([]),
		storageIds: new Map<string, string>(),
	});

const OPENROUTER_PROVIDER_ID = "openrouter";
const BUILT_IN_PROVIDER_IDS = new Set([
	"openai",
	"anthropic",
	"google",
	"opencode-go",
	"deepseek",
	OPENROUTER_PROVIDER_ID,
]);

const closeProviderInstances = async (
	providers: readonly Provider[]
): Promise<void> => {
	await Promise.allSettled(
		providers.map((provider) =>
			Promise.resolve().then(() => provider.close?.())
		)
	);
};

const createProviderBackend = async (
	options: InteractiveSessionProviderCollectionOptions,
	pluginProviders: readonly PluginProviderDescriptor[]
): Promise<ProviderCollectionBackend> => {
	const providers: Provider[] = [];
	const storageIds = new Map<string, string>();
	const addProvider = (provider: Provider, storageId: string): void => {
		providers.push(provider);
		if (storageIds.has(provider.id)) {
			throw new Error(`Duplicate Provider ID '${provider.id}'.`);
		}
		storageIds.set(provider.id, storageId);
	};
	try {
		addProvider(
			createOpenRouterProvider(options.openRouterProviderOptions),
			OPENROUTER_PROVIDER_ID
		);
		for (const registration of pluginProviders) {
			if (BUILT_IN_PROVIDER_IDS.has(registration.providerId)) {
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
		backingCredentials =
			options.credentialStore ??
			createProviderSdkCredentialStore({ userDataDir: options.userDataDir });
		backingModels =
			options.modelStore ??
			createProviderSdkModelStore({ userDataDir: options.userDataDir });
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
	const activeCollection = (): ProviderCollection => backend.collection;
	const close = (): Promise<void> => {
		if (closePromise !== undefined) {
			return closePromise;
		}
		const previousCollection = activeCollection();
		backend = createFailClosedBackend();
		closePromise = previousCollection.close();
		return closePromise;
	};
	const interactiveCollection: InteractiveSessionProviderCollection = {
		chat: (request) => activeCollection().chat(request),
		close,
		deleteCredential: (providerId) =>
			activeCollection().deleteCredential(providerId),
		getAvailable: () => activeCollection().getAvailable(),
		getModel: (providerId, modelId) =>
			activeCollection().getModel(providerId, modelId),
		getModels: () => activeCollection().getModels(),
		restoreModels: () => activeCollection().restoreModels(),
		refreshModels: (providerId, refreshOptions) =>
			activeCollection().refreshModels(providerId, refreshOptions),
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
		supportsModelDiscovery: (providerId) =>
			backend.discoverableProviderIds.has(providerId),
		failClosed: close,
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
	sessionId?: string
): readonly PluginProviderDescriptor[] =>
	pluginRuntime?.getProviderRegistrations(sessionId) ?? [];

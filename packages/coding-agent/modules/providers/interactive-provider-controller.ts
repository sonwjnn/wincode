import type {
	ProviderCollection,
	ProviderModel,
	RefreshModelsOptions,
} from "@wincode/ai/sdk";
import { isJsonValue } from "@wincode/utils";
import type {
	PluginJsonValue,
	PluginProviderConnectContext,
} from "@/modules/plugins/public";
import type { PluginProviderDescriptor } from "@/modules/plugins/runtime";

const OPENROUTER_PROVIDER_ID = "openrouter";

export type InteractiveProviderOption = Readonly<{
	displayName: string;
	kind: "openrouter" | "plugin";
	providerId: string;
}>;

export type PluginProviderComposition = Readonly<{
	providerCollection: ProviderCollection;
	registration: PluginProviderDescriptor;
	supportsModelDiscovery: boolean;
}>;

export type PluginProviderConnectionOutcome =
	| Readonly<{
			kind: "connected";
			models: readonly ProviderModel[];
	  }>
	| Readonly<{ kind: "saved-before-cancelled" }>;

export type InteractiveProviderControllerOptions = Readonly<{
	getDiscoverableProviderIds?: () => readonly string[];
	getPluginProviderComposition?: (
		providerId: string
	) => PluginProviderComposition | undefined;
	getPluginProviderRegistrations?: () => readonly PluginProviderDescriptor[];
	supportsModelDiscovery?: (providerId: string) => boolean;
	withSessionWork?: <Result>(action: () => Promise<Result>) => Promise<Result>;
}>;

export type InteractiveProviderController = Readonly<{
	connectOpenRouterApiKey: (
		apiKey: string,
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	connectPluginProvider: (
		providerId: string,
		requestTextInput: PluginProviderConnectContext["requestTextInput"],
		options?: RefreshModelsOptions
	) => Promise<PluginProviderConnectionOutcome | undefined>;
	getAvailableModels: () => Promise<readonly ProviderModel[]>;
	getConnectableProviders: () => readonly InteractiveProviderOption[];
	getKnownModels: () => Promise<readonly ProviderModel[]>;
	restoreModels: () => Promise<void>;
	refreshModels: (
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	refreshProviderModels: (
		providerId: string,
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
}>;

const isAborted = (signal: AbortSignal | undefined): boolean =>
	signal?.aborted === true;

const abortReason = (signal: AbortSignal): Error =>
	signal.reason instanceof Error
		? signal.reason
		: new DOMException("Aborted", "AbortError");

const pluginCompositionFor = (
	providers: ProviderCollection,
	options: InteractiveProviderControllerOptions,
	providerId: string
): PluginProviderComposition | undefined => {
	if (options.getPluginProviderComposition !== undefined) {
		return options.getPluginProviderComposition(providerId);
	}
	const registration = options
		.getPluginProviderRegistrations?.()
		.find((candidate) => candidate.providerId === providerId);
	if (registration === undefined) {
		return;
	}
	return Object.freeze({
		providerCollection: providers,
		registration,
		supportsModelDiscovery:
			options.supportsModelDiscovery?.(providerId) ?? true,
	});
};

const requestPluginCredential = async (
	registration: PluginProviderDescriptor,
	requestTextInput: PluginProviderConnectContext["requestTextInput"],
	signal: AbortSignal
): Promise<PluginJsonValue | undefined> => {
	if (isAborted(signal)) {
		return;
	}
	let credential: PluginJsonValue | undefined;
	try {
		credential = await registration.connect(
			Object.freeze({ requestTextInput, signal })
		);
	} catch {
		if (isAborted(signal)) {
			return;
		}
		throw new Error("Plugin Provider connection interaction failed.");
	}
	if (credential === undefined || isAborted(signal)) {
		return;
	}
	if (!isJsonValue(credential, { maxDepth: 32, rejectToJSON: true })) {
		throw new Error("Plugin Provider returned an invalid credential value.");
	}
	return structuredClone(credential);
};

const savePluginCredential = async (
	composition: PluginProviderComposition,
	providerId: string,
	credential: PluginJsonValue,
	signal: AbortSignal,
	refreshOptions: RefreshModelsOptions | undefined
): Promise<PluginProviderConnectionOutcome | undefined> => {
	if (isAborted(signal)) {
		return;
	}
	try {
		await composition.providerCollection.setCredential(providerId, credential);
	} catch (error) {
		if (isAborted(signal)) {
			return;
		}
		throw error;
	}
	if (isAborted(signal)) {
		return { kind: "saved-before-cancelled" };
	}
	if (!composition.supportsModelDiscovery) {
		return {
			kind: "connected",
			models: composition.providerCollection
				.getModels()
				.filter((model) => model.providerId === providerId),
		};
	}
	try {
		const models = await composition.providerCollection.refreshModels(
			providerId,
			refreshOptions
		);
		return isAborted(signal)
			? { kind: "saved-before-cancelled" }
			: { kind: "connected", models };
	} catch {
		if (isAborted(signal)) {
			return { kind: "saved-before-cancelled" };
		}
		throw new Error(
			"Plugin Provider credentials were saved, but Known Model refresh failed; the last-known models were retained."
		);
	}
};

const runPluginProviderConnection = async (
	providers: ProviderCollection,
	options: InteractiveProviderControllerOptions,
	providerId: string,
	requestTextInput: PluginProviderConnectContext["requestTextInput"],
	refreshOptions: RefreshModelsOptions | undefined
): Promise<PluginProviderConnectionOutcome | undefined> => {
	const composition = pluginCompositionFor(providers, options, providerId);
	if (composition === undefined) {
		throw new Error("Plugin Provider connection is unavailable.");
	}
	const signal = refreshOptions?.signal ?? new AbortController().signal;
	const credential = await requestPluginCredential(
		composition.registration,
		requestTextInput,
		signal
	);
	if (credential === undefined) {
		return;
	}
	return savePluginCredential(
		composition,
		providerId,
		credential,
		signal,
		refreshOptions
	);
};

/** Binds Interactive provider actions to a Host-owned ProviderCollection. */
export const createInteractiveProviderController = (
	providers: ProviderCollection,
	options: InteractiveProviderControllerOptions = {}
): InteractiveProviderController => {
	const getPluginProviderRegistrations =
		options.getPluginProviderRegistrations ?? (() => []);
	const getDiscoverableProviderIds =
		options.getDiscoverableProviderIds ?? (() => [OPENROUTER_PROVIDER_ID]);
	const withSessionWork =
		options.withSessionWork ??
		(<Result>(action: () => Promise<Result>) => action());
	const restoreModels = (): Promise<void> => providers.restoreModels();
	const refreshProviderModels = (
		providerId: string,
		refreshOptions?: RefreshModelsOptions
	): Promise<readonly ProviderModel[]> =>
		withSessionWork(async () => {
			await restoreModels();
			return providers.refreshModels(providerId, refreshOptions);
		});
	const refreshModels = (
		refreshOptions?: RefreshModelsOptions
	): Promise<readonly ProviderModel[]> =>
		withSessionWork(async () => {
			await restoreModels();
			const providerIds = getDiscoverableProviderIds();
			const results = await Promise.allSettled(
				providerIds.map((providerId) =>
					providers.refreshModels(providerId, refreshOptions)
				)
			);
			if (refreshOptions?.signal?.aborted === true) {
				throw abortReason(refreshOptions.signal);
			}
			const successfulRefreshes = results.filter(
				(result) => result.status === "fulfilled"
			).length;
			if (providerIds.length > 0 && successfulRefreshes === 0) {
				throw new Error(
					"Known Model refresh failed; the last-known model snapshots were retained."
				);
			}
			return providers.getAvailable();
		});
	return Object.freeze({
		connectOpenRouterApiKey(apiKey, refreshOptions) {
			return withSessionWork(async () => {
				const trimmedApiKey = apiKey.trim();
				if (trimmedApiKey.length === 0) {
					throw new Error("OpenRouter API key must not be empty.");
				}
				if (refreshOptions?.signal?.aborted === true) {
					throw abortReason(refreshOptions.signal);
				}
				await restoreModels();
				await providers.setCredential(OPENROUTER_PROVIDER_ID, {
					apiKey: trimmedApiKey,
					kind: "api-key",
				});
				try {
					return await providers.refreshModels(
						OPENROUTER_PROVIDER_ID,
						refreshOptions
					);
				} catch (error) {
					throw new Error(
						"OpenRouter credentials were saved, but Known Model refresh failed; the last-known models were retained.",
						{ cause: error }
					);
				}
			});
		},
		connectPluginProvider(providerId, requestTextInput, refreshOptions) {
			return withSessionWork(() =>
				runPluginProviderConnection(
					providers,
					options,
					providerId,
					requestTextInput,
					refreshOptions
				)
			);
		},
		async getAvailableModels() {
			await restoreModels();
			return providers.getAvailable();
		},
		getConnectableProviders() {
			const discoverableProviderIds = new Set(getDiscoverableProviderIds());
			return Object.freeze([
				...(discoverableProviderIds.has(OPENROUTER_PROVIDER_ID)
					? [
							{
								displayName: "OpenRouter Provider SDK",
								kind: "openrouter" as const,
								providerId: OPENROUTER_PROVIDER_ID,
							},
						]
					: []),
				...getPluginProviderRegistrations().map((registration) =>
					Object.freeze({
						displayName: registration.displayName,
						kind: "plugin" as const,
						providerId: registration.providerId,
					})
				),
			]);
		},
		async getKnownModels() {
			await restoreModels();
			return providers.getModels();
		},
		restoreModels,
		refreshModels,
		refreshProviderModels,
	});
};

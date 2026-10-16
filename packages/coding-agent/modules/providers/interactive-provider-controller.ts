import type {
	ProviderCollection,
	ProviderModel,
	RefreshModelsOptions,
} from "@wincode/ai/sdk";
import type { OpenAIBrowserLoginOptions } from "@wincode/ai/sdk/providers/openai";
import { isJsonValue } from "@wincode/utils";
import type {
	PluginJsonValue,
	PluginProviderConnectContext,
} from "@/modules/plugins/public";
import type { PluginProviderDescriptor } from "@/modules/plugins/runtime";
import {
	BUILT_IN_API_KEY_PROVIDER_OPTIONS,
	BUILT_IN_PROVIDER_CATALOG,
	type BuiltInProviderConnectMethod,
	OPENROUTER_PROVIDER_ID,
} from "@/modules/providers/built-in-provider-catalog";
import {
	arePluginProviderRegistrationsBoundToTrustedOwners,
	createProviderModelSelectionSnapshot,
	type ProviderModelSelection,
	type ProviderModelSelectionCandidate,
	type ProviderModelSelectionSnapshot,
	providerModelSelectionCandidateForModel,
	providerModelSelectionForCandidate,
	providerModelSelectionSnapshotsMatch,
	STALE_PROVIDER_MODEL_SELECTION_MESSAGE,
	UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE,
} from "@/modules/providers/provider-model-selection";

const API_KEY_PROVIDER_OPTIONS = BUILT_IN_API_KEY_PROVIDER_OPTIONS;
const API_KEY_PROVIDER_IDS = new Set<string>(
	API_KEY_PROVIDER_OPTIONS.map(({ providerId }) => providerId)
);

export type ProviderOAuthConnectOptions = Readonly<{
	onStatus?: (status: string) => void;
	signal?: AbortSignal;
}>;

type ProviderApiKeyConnect = (
	providerId: string,
	apiKey: string,
	options?: RefreshModelsOptions
) => Promise<readonly ProviderModel[]>;

type ProviderOAuthConnect = (
	options?: ProviderOAuthConnectOptions
) => Promise<readonly ProviderModel[]>;

type ProviderPluginConnect = (
	requestTextInput: PluginProviderConnectContext["requestTextInput"],
	options?: RefreshModelsOptions
) => Promise<PluginProviderConnectionOutcome | undefined>;

type BuiltInProviderConnectHandlers = Readonly<{
	apiKey: ReadonlyMap<string, ProviderApiKeyConnect>;
	discovery: ReadonlyMap<string, ProviderApiKeyConnect>;
	oauth: ReadonlyMap<string, ProviderOAuthConnect>;
	availableOAuthMethodIds: ReadonlySet<string>;
}>;

export type InteractiveProviderOption =
	| Readonly<{
			connectApiKey: (
				apiKey: string,
				options?: RefreshModelsOptions
			) => Promise<readonly ProviderModel[]>;
			displayName: string;
			kind: "api-key";
			methodId: string;
			providerId: string;
	  }>
	| Readonly<{
			connectApiKey: (
				apiKey: string,
				options?: RefreshModelsOptions
			) => Promise<readonly ProviderModel[]>;
			displayName: string;
			inputPrompt?: string;
			kind: "api-key-with-model-discovery";
			methodId: string;
			providerId: string;
			successMessage?: string;
	  }>
	| Readonly<{
			connectOAuth: ProviderOAuthConnect;
			displayName: string;
			kind: "oauth";
			methodId: string;
			providerId: string;
			successMessage?: string;
	  }>
	| Readonly<{
			connectPlugin: ProviderPluginConnect;
			displayName: string;
			kind: "plugin";
			methodId: "plugin";
			providerId: string;
	  }>;

type BuiltInConnectableProviderOption = Exclude<
	InteractiveProviderOption,
	{ kind: "plugin" }
>;

const connectMethodOrder = {
	oauth: 0,
	"api-key-with-model-discovery": 1,
	"api-key": 2,
} satisfies Record<BuiltInConnectableProviderOption["kind"], number>;

const createBuiltInConnectableProviderOption = (
	providerId: string,
	displayName: string,
	method: BuiltInProviderConnectMethod,
	knownProviderIds: ReadonlySet<string>,
	discoverableProviderIds: ReadonlySet<string>,
	handlers: BuiltInProviderConnectHandlers
): BuiltInConnectableProviderOption | undefined => {
	switch (method.kind) {
		case "api-key": {
			if (!knownProviderIds.has(providerId)) {
				return;
			}
			const connect = handlers.apiKey.get(method.methodId);
			if (connect === undefined) {
				throw new Error(
					`No API-key handler is registered for '${method.methodId}'.`
				);
			}
			return Object.freeze({
				connectApiKey: (apiKey, options) =>
					connect(providerId, apiKey, options),
				displayName,
				kind: method.kind,
				methodId: method.methodId,
				providerId,
			});
		}
		case "api-key-with-model-discovery": {
			if (!discoverableProviderIds.has(providerId)) {
				return;
			}
			const connect = handlers.discovery.get(method.methodId);
			if (connect === undefined) {
				throw new Error(
					`No model-discovery handler is registered for '${method.methodId}'.`
				);
			}
			return Object.freeze({
				connectApiKey: (apiKey, options) =>
					connect(providerId, apiKey, options),
				displayName,
				inputPrompt: method.inputPrompt,
				kind: method.kind,
				methodId: method.methodId,
				providerId,
				...(method.successMessage === undefined
					? {}
					: { successMessage: method.successMessage }),
			});
		}
		case "oauth": {
			const connect = handlers.oauth.get(method.methodId);
			if (connect === undefined) {
				throw new Error(
					`No OAuth handler is registered for '${method.methodId}'.`
				);
			}
			if (!handlers.availableOAuthMethodIds.has(method.methodId)) {
				return;
			}
			return Object.freeze({
				connectOAuth: connect,
				displayName: method.displayName,
				kind: method.kind,
				methodId: method.methodId,
				providerId,
				...(method.successMessage === undefined
					? {}
					: { successMessage: method.successMessage }),
			});
		}
		default:
			throw new Error("Unknown built-in Provider connection method.");
	}
};

const getBuiltInConnectableProviders = (
	knownModels: readonly ProviderModel[],
	discoverableProviderIds: ReadonlySet<string>,
	handlers: BuiltInProviderConnectHandlers
): readonly BuiltInConnectableProviderOption[] => {
	const knownProviderIds = new Set(
		knownModels.map(({ providerId }) => providerId)
	);
	const options: BuiltInConnectableProviderOption[] = [];
	for (const [providerId, definition] of Object.entries(
		BUILT_IN_PROVIDER_CATALOG
	)) {
		for (const method of definition.connectMethods) {
			const option = createBuiltInConnectableProviderOption(
				providerId,
				definition.displayName,
				method,
				knownProviderIds,
				discoverableProviderIds,
				handlers
			);
			if (option !== undefined) {
				options.push(option);
			}
		}
	}
	return Object.freeze(
		options.sort(
			(left, right) =>
				connectMethodOrder[left.kind] - connectMethodOrder[right.kind]
		)
	);
};

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
	loginOpenAIOAuth?: (
		options?: OpenAIBrowserLoginOptions
	) => Promise<readonly ProviderModel[]>;
	getPluginProviderComposition?: (
		providerId: string
	) => PluginProviderComposition | undefined;
	getPluginProviderRegistrations?: () => readonly PluginProviderDescriptor[];
	getTrustedPluginProviderRegistrations?: () => readonly PluginProviderDescriptor[];
	getTrustedPluginProviderRuntime?: () => object | undefined;
	supportsModelDiscovery?: (providerId: string) => boolean;
	withSessionWork?: <Result>(action: () => Promise<Result>) => Promise<Result>;
	getCompositionRevision?: () => number;
	subscribeComposition?: (listener: () => void) => () => void;
}>;

export type InteractiveProviderController = Readonly<{
	connectOpenAIOAuth: (
		options?: OpenAIBrowserLoginOptions
	) => Promise<readonly ProviderModel[]>;
	connectOpenRouterApiKey: (
		apiKey: string,
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	connectProviderApiKey: (
		providerId: string,
		apiKey: string,
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	connectPluginProvider: (
		providerId: string,
		requestTextInput: PluginProviderConnectContext["requestTextInput"],
		options?: RefreshModelsOptions
	) => Promise<PluginProviderConnectionOutcome | undefined>;
	getAvailableModels: (
		providerId?: string
	) => Promise<readonly ProviderModel[]>;
	getAvailableProviderModelSelectionCandidates?: (
		providerId?: string
	) => Promise<readonly ProviderModelSelectionCandidate[]>;
	getCompositionRevision?: () => number;
	getAvailabilityRevision?: () => number;
	getConnectableProviders: () => readonly InteractiveProviderOption[];
	getKnownModels: () => Promise<readonly ProviderModel[]>;
	getPluginProviderComposition?: (
		providerId: string
	) => PluginProviderComposition | undefined;
	getPluginProviderRegistrations: () => readonly PluginProviderDescriptor[];
	restoreModels: () => Promise<void>;
	refreshModels: (
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	refreshProviderModelSelectionCandidates?: (
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModelSelectionCandidate[]>;
	selectProviderModelSelectionCandidate?: <Result>(
		candidate: ProviderModelSelectionCandidate,
		action: (
			model: ProviderModel,
			selection: ProviderModelSelection
		) => Result | Promise<Result>
	) => Promise<Result>;
	refreshProviderModels: (
		providerId: string,
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	subscribeComposition?: (listener: () => void) => () => void;
	subscribeAvailability?: (listener: () => void) => () => void;
}>;

const isAborted = (signal: AbortSignal | undefined): boolean =>
	signal?.aborted === true;

const abortReason = (signal: AbortSignal): Error =>
	signal.reason instanceof Error
		? signal.reason
		: new DOMException("Aborted", "AbortError");

const throwIfAborted = (signal: AbortSignal | undefined): void => {
	if (signal?.aborted === true) {
		throw abortReason(signal);
	}
};

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
	const availabilityListeners = new Set<() => void>();
	let availabilityRevision = 0;
	const notifyAvailabilityChanged = (): void => {
		availabilityRevision += 1;
		for (const listener of [...availabilityListeners]) {
			try {
				listener();
			} catch {
				// One subscriber cannot interrupt credential or availability updates.
			}
		}
	};
	const restoreModels = (): Promise<void> => providers.restoreModels();
	const trustedOwnerRegistrations = () =>
		(options.getTrustedPluginProviderRegistrations?.() ?? []).map(
			({ pluginId, providerId, sourceIdentity }) => ({
				pluginId,
				providerId,
				sourceIdentity,
			})
		);
	const hostOwnerRegistrations = () =>
		getPluginProviderRegistrations().map(
			({ pluginId, providerId, sourceIdentity }) => ({
				pluginId,
				providerId,
				sourceIdentity,
			})
		);
	const currentProviderModelSelectionSnapshot =
		(): ProviderModelSelectionSnapshot => {
			const snapshot = createProviderModelSelectionSnapshot(
				trustedOwnerRegistrations(),
				hostOwnerRegistrations(),
				options.getCompositionRevision?.() ?? 0,
				options.getTrustedPluginProviderRuntime?.()
			);
			if (
				!arePluginProviderRegistrationsBoundToTrustedOwners(
					snapshot.trustedRegistrations,
					snapshot.hostRegistrations
				)
			) {
				throw new Error(UNVERIFIED_PLUGIN_PROVIDER_REGISTRATIONS_MESSAGE);
			}
			return snapshot;
		};
	const assertProviderModelSelectionSnapshotCurrent = (
		expected?: ProviderModelSelectionSnapshot
	): ProviderModelSelectionSnapshot => {
		const current = currentProviderModelSelectionSnapshot();
		if (
			expected !== undefined &&
			!providerModelSelectionSnapshotsMatch(expected, current)
		) {
			throw new Error(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
		}
		return current;
	};
	const withRequiredProviderModelSelectionWork = async <Result>(
		action: () => Promise<Result>
	): Promise<Result> => {
		if (options.withSessionWork === undefined) {
			throw new Error(
				"Provider Model selection requires a reload-blocking Session work lease."
			);
		}
		return options.withSessionWork(action);
	};
	const providerModelSelectionCandidatesForModels = (
		models: readonly ProviderModel[],
		snapshot: ProviderModelSelectionSnapshot
	): readonly ProviderModelSelectionCandidate[] =>
		models.flatMap((model) => {
			const candidate = providerModelSelectionCandidateForModel(
				model,
				snapshot
			);
			return candidate === undefined ? [] : [candidate];
		});
	const refreshWithAvailabilityNotification = async <Result>(
		action: () => Promise<Result>
	): Promise<Result> => {
		const modelsBefore = providers.getModels();
		try {
			return await action();
		} finally {
			if (!Bun.deepEquals(modelsBefore, providers.getModels(), true)) {
				notifyAvailabilityChanged();
			}
		}
	};
	const refreshProviderModels = (
		providerId: string,
		refreshOptions?: RefreshModelsOptions
	): Promise<readonly ProviderModel[]> =>
		withSessionWork(() =>
			refreshWithAvailabilityNotification(async () => {
				await restoreModels();
				return providers.refreshModels(providerId, refreshOptions);
			})
		);
	const refreshModels = (
		refreshOptions?: RefreshModelsOptions
	): Promise<readonly ProviderModel[]> =>
		withSessionWork(() =>
			refreshWithAvailabilityNotification(async () => {
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
			})
		);
	const getAvailableProviderModelSelectionCandidates = async (
		providerId?: string
	): Promise<readonly ProviderModelSelectionCandidate[]> =>
		withRequiredProviderModelSelectionWork(async () => {
			const snapshot = currentProviderModelSelectionSnapshot();
			await restoreModels();
			assertProviderModelSelectionSnapshotCurrent(snapshot);
			const models = await providers.getAvailable(providerId);
			assertProviderModelSelectionSnapshotCurrent(snapshot);
			return providerModelSelectionCandidatesForModels(models, snapshot);
		});
	const refreshProviderModelSelectionCandidates = (
		refreshOptions?: RefreshModelsOptions
	): Promise<readonly ProviderModelSelectionCandidate[]> =>
		withRequiredProviderModelSelectionWork(() =>
			refreshWithAvailabilityNotification(async () => {
				const snapshot = currentProviderModelSelectionSnapshot();
				await restoreModels();
				assertProviderModelSelectionSnapshotCurrent(snapshot);
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
				const currentSnapshot =
					assertProviderModelSelectionSnapshotCurrent(snapshot);
				const models = await providers.getAvailable();
				assertProviderModelSelectionSnapshotCurrent(currentSnapshot);
				return providerModelSelectionCandidatesForModels(
					models,
					currentSnapshot
				);
			})
		);
	const selectProviderModelSelectionCandidate = <Result>(
		candidate: ProviderModelSelectionCandidate,
		action: (
			model: ProviderModel,
			selection: ProviderModelSelection
		) => Result | Promise<Result>
	): Promise<Result> =>
		withRequiredProviderModelSelectionWork(async () => {
			const currentSnapshot = currentProviderModelSelectionSnapshot();
			if (
				!providerModelSelectionSnapshotsMatch(
					candidate.snapshot,
					currentSnapshot
				)
			) {
				throw new Error(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
			}
			const selection = providerModelSelectionForCandidate(
				candidate,
				currentSnapshot
			);
			if (selection === undefined) {
				throw new Error(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
			}
			return await action(candidate.model, selection);
		});
	const connectOpenAIOAuth = (
		loginOptions: OpenAIBrowserLoginOptions = {}
	): Promise<readonly ProviderModel[]> =>
		withSessionWork(async () => {
			const login = options.loginOpenAIOAuth;
			if (login === undefined) {
				throw new Error("OpenAI browser sign-in is unavailable.");
			}
			throwIfAborted(loginOptions.signal);
			await restoreModels();
			try {
				const models = await login(loginOptions);
				throwIfAborted(loginOptions.signal);
				return models;
			} catch {
				if (loginOptions.signal?.aborted) {
					throw abortReason(loginOptions.signal);
				}
				throw new Error("OpenAI browser sign-in failed.");
			} finally {
				notifyAvailabilityChanged();
			}
		});
	const connectOpenRouterApiKey = (
		apiKey: string,
		refreshOptions?: RefreshModelsOptions
	): Promise<readonly ProviderModel[]> =>
		withSessionWork(async () => {
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
			} finally {
				notifyAvailabilityChanged();
			}
		});
	const connectProviderApiKey = (
		providerId: string,
		apiKey: string,
		refreshOptions?: RefreshModelsOptions
	): Promise<readonly ProviderModel[]> =>
		withSessionWork(async () => {
			const signal = refreshOptions?.signal;
			if (!API_KEY_PROVIDER_IDS.has(providerId)) {
				throw new Error("Provider SDK API-key connection is unavailable.");
			}
			const trimmedApiKey = apiKey.trim();
			if (trimmedApiKey.length === 0) {
				throw new Error("Provider SDK API key must not be empty.");
			}
			throwIfAborted(signal);
			await restoreModels();
			throwIfAborted(signal);
			try {
				await providers.setCredential(providerId, {
					apiKey: trimmedApiKey,
					kind: "api-key",
				});
			} catch {
				throw new Error("Could not save Provider SDK credentials.");
			} finally {
				notifyAvailabilityChanged();
			}
			return providers
				.getModels()
				.filter((model) => model.providerId === providerId);
		});
	const connectPluginProvider = (
		providerId: string,
		requestTextInput: PluginProviderConnectContext["requestTextInput"],
		refreshOptions?: RefreshModelsOptions
	): Promise<PluginProviderConnectionOutcome | undefined> =>
		withSessionWork(async () => {
			try {
				return await runPluginProviderConnection(
					providers,
					options,
					providerId,
					requestTextInput,
					refreshOptions
				);
			} finally {
				notifyAvailabilityChanged();
			}
		});
	const oauthConnectHandlers = new Map<string, ProviderOAuthConnect>([
		["openai-browser", (oauthOptions) => connectOpenAIOAuth(oauthOptions)],
	]);
	const availableOAuthMethodIds = new Set<string>();
	if (options.loginOpenAIOAuth !== undefined) {
		availableOAuthMethodIds.add("openai-browser");
	}
	const builtInConnectHandlers: BuiltInProviderConnectHandlers = {
		apiKey: new Map<string, ProviderApiKeyConnect>([
			["provider-api-key", connectProviderApiKey],
		]),
		discovery: new Map<string, ProviderApiKeyConnect>([
			[
				"openrouter-api-key",
				(providerId, apiKey, refreshOptions) => {
					if (providerId !== OPENROUTER_PROVIDER_ID) {
						throw new Error(
							"OpenRouter API-key discovery method is configured for an unsupported Provider."
						);
					}
					return connectOpenRouterApiKey(apiKey, refreshOptions);
				},
			],
		]),
		oauth: oauthConnectHandlers,
		availableOAuthMethodIds,
	};
	return Object.freeze({
		getPluginProviderComposition: (providerId) =>
			pluginCompositionFor(providers, options, providerId),
		getPluginProviderRegistrations,
		connectOpenAIOAuth,
		getCompositionRevision: () => options.getCompositionRevision?.() ?? 0,
		subscribeComposition: (listener) =>
			options.subscribeComposition?.(listener) ?? (() => undefined),
		getAvailabilityRevision: () => availabilityRevision,
		subscribeAvailability(listener) {
			availabilityListeners.add(listener);
			return () => availabilityListeners.delete(listener);
		},
		connectOpenRouterApiKey,
		connectProviderApiKey,
		connectPluginProvider,
		async getAvailableModels(providerId) {
			await restoreModels();
			return providers.getAvailable(providerId);
		},
		getAvailableProviderModelSelectionCandidates,
		getConnectableProviders() {
			const discoverableProviderIds = new Set(getDiscoverableProviderIds());
			return Object.freeze([
				...getBuiltInConnectableProviders(
					providers.getModels(),
					discoverableProviderIds,
					builtInConnectHandlers
				),
				...getPluginProviderRegistrations().map((registration) =>
					Object.freeze({
						connectPlugin: (
							requestTextInput: PluginProviderConnectContext["requestTextInput"],
							refreshOptions?: RefreshModelsOptions
						) =>
							connectPluginProvider(
								registration.providerId,
								requestTextInput,
								refreshOptions
							),
						displayName: registration.displayName,
						kind: "plugin" as const,
						methodId: "plugin" as const,
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
		refreshProviderModelSelectionCandidates,
		refreshProviderModels,
		selectProviderModelSelectionCandidate,
	});
};

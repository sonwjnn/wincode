import type {
	ProviderCollection,
	ProviderModel,
	RefreshModelsOptions,
} from "@wincode/ai/sdk";

const OPENROUTER_PROVIDER_ID = "openrouter";

export type InteractiveProviderController = Readonly<{
	connectOpenRouterApiKey: (
		apiKey: string,
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
	getAvailableModels: () => Promise<readonly ProviderModel[]>;
	getKnownModels: () => Promise<readonly ProviderModel[]>;
	restoreModels: () => Promise<void>;
	refreshModels: (
		options?: RefreshModelsOptions
	) => Promise<readonly ProviderModel[]>;
}>;

/** Binds Interactive provider actions to a Host-owned or short-lived collection. */
export const createInteractiveProviderController = (
	providers: ProviderCollection
): InteractiveProviderController => {
	const restoreModels = (): Promise<void> => providers.restoreModels();
	const refreshModels = async (
		options?: RefreshModelsOptions
	): Promise<readonly ProviderModel[]> => {
		await restoreModels();
		return providers.refreshModels(OPENROUTER_PROVIDER_ID, options);
	};

	return Object.freeze({
		async connectOpenRouterApiKey(apiKey, options) {
			const trimmedApiKey = apiKey.trim();
			if (trimmedApiKey.length === 0) {
				throw new Error("OpenRouter API key must not be empty.");
			}
			if (options?.signal?.aborted) {
				throw (
					options.signal.reason ?? new DOMException("Aborted", "AbortError")
				);
			}
			await restoreModels();
			await providers.setCredential(OPENROUTER_PROVIDER_ID, {
				apiKey: trimmedApiKey,
				kind: "api-key",
			});
			try {
				return await providers.refreshModels(OPENROUTER_PROVIDER_ID, options);
			} catch (error) {
				throw new Error(
					"OpenRouter credentials were saved, but Known Model refresh failed; the last-known models were retained.",
					{ cause: error }
				);
			}
		},
		async getAvailableModels() {
			await restoreModels();
			return providers.getAvailable();
		},
		async getKnownModels() {
			await restoreModels();
			return providers.getModels();
		},
		restoreModels,
		refreshModels,
	});
};

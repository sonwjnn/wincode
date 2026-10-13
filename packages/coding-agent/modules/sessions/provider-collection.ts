import {
	type CredentialStore,
	createProviderCollection,
	type ModelStore,
	type ProviderCollection,
} from "@wincode/ai/sdk";
import {
	createOpenRouterProvider,
	type OpenRouterProviderOptions,
} from "@wincode/ai/sdk/providers/openrouter";
import {
	createProviderSdkCredentialStore,
	createProviderSdkModelStore,
} from "@/modules/providers/provider-stores";

/** Non-Interactive execution modes stay on their existing runtime in this slice. */
export const createDefaultSessionProviderCollection = ():
	| ProviderCollection
	| undefined => undefined;

export type InteractiveSessionProviderCollectionOptions = Readonly<{
	credentialStore?: CredentialStore;
	modelStore?: ModelStore;
	openRouterProviderOptions?: OpenRouterProviderOptions;
	userDataDir?: string;
}>;

/** Creates fresh OpenRouter SDK state for one Interactive Session Host. */
export const createInteractiveSessionProviderCollection = (
	options: InteractiveSessionProviderCollectionOptions = {}
): ProviderCollection => {
	const providers = createProviderCollection({
		credentialStore:
			options.credentialStore ??
			createProviderSdkCredentialStore({ userDataDir: options.userDataDir }),
		modelStore:
			options.modelStore ??
			createProviderSdkModelStore({ userDataDir: options.userDataDir }),
	});
	providers.register(
		createOpenRouterProvider(options.openRouterProviderOptions)
	);
	return providers;
};

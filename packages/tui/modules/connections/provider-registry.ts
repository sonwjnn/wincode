import type { ConnectionProviderId } from "@wincode/ai/models";
import {
	createAnthropicProviderDefinition,
	createGoogleProviderDefinition,
	createOpenAIProviderDefinition,
	createOpenCodeGoProviderDefinition,
	type ProviderAdapterDependencies,
	type ProviderSummary,
} from "./provider-definition";

export const providerOrder = [
	"anthropic",
	"google",
	"openai",
	"opencode-go",
] as const satisfies readonly ConnectionProviderId[];
const providerFactories = {
	anthropic: createAnthropicProviderDefinition,
	google: createGoogleProviderDefinition,
	openai: createOpenAIProviderDefinition,
	"opencode-go": createOpenCodeGoProviderDefinition,
} satisfies {
	[P in ConnectionProviderId]: (deps: ProviderAdapterDependencies) => {
		readonly id: P;
	};
};

export type ProviderRegistry = {
	[P in keyof typeof providerFactories]: ReturnType<
		(typeof providerFactories)[P]
	>;
};
export type ProviderAdapterMap = {
	[P in keyof ProviderRegistry]: Pick<
		ProviderRegistry[P],
		"connect" | "authorize" | "methods" | "status"
	>;
};
export type ConnectRequestByProvider = {
	[P in keyof ProviderRegistry]: Parameters<ProviderRegistry[P]["connect"]>[0];
};
export type ConnectRequest =
	ConnectRequestByProvider[keyof ConnectRequestByProvider];
export type ConnectRequestFor<P extends ConnectionProviderId> = Extract<
	ConnectRequest,
	{ providerId: P }
>;
export type CredentialByProvider = {
	[P in keyof ProviderRegistry]: Parameters<
		ProviderRegistry[P]["authorize"]
	>[0];
};
export type AuthorizationByProvider = {
	[P in keyof ProviderRegistry]: Awaited<
		ReturnType<ProviderRegistry[P]["authorize"]>
	>["authorization"];
};
export const createProviderRegistry = (
	deps: ProviderAdapterDependencies
): ProviderRegistry => ({
	anthropic: providerFactories.anthropic(deps),
	google: providerFactories.google(deps),
	openai: providerFactories.openai(deps),
	"opencode-go": providerFactories["opencode-go"](deps),
});

export const defaultProviderRegistry = createProviderRegistry({});
export const providerDisplayNames = {
	anthropic: defaultProviderRegistry.anthropic.displayName,
	google: defaultProviderRegistry.google.displayName,
	openai: defaultProviderRegistry.openai.displayName,
	"opencode-go": defaultProviderRegistry["opencode-go"].displayName,
} satisfies { [P in ConnectionProviderId]: ProviderRegistry[P]["displayName"] };
export const credentialSchemas = {
	anthropic: defaultProviderRegistry.anthropic.credentialSchema,
	google: defaultProviderRegistry.google.credentialSchema,
	openai: defaultProviderRegistry.openai.credentialSchema,
	"opencode-go": defaultProviderRegistry["opencode-go"].credentialSchema,
} satisfies {
	[P in ConnectionProviderId]: ProviderRegistry[P]["credentialSchema"];
};

export type ProviderRegistryId = keyof ProviderRegistry & ConnectionProviderId;

export type ProviderService<P extends ConnectionProviderId> = {
	status(): Promise<ProviderSummary>;
	authorize(signal?: AbortSignal): Promise<AuthorizationByProvider[P]>;
	connect(request: ConnectRequestFor<P>): Promise<void>;
};

export function composeProviderServices<
	T extends {
		[P in ConnectionProviderId]: unknown;
	},
>(
	adapters: ProviderAdapterMap,
	create: <P extends ConnectionProviderId>(
		id: P,
		adapter: ProviderAdapterMap[P]
	) => T[P] | ProviderService<P>
): { [P in ConnectionProviderId]: T[P] };
export function composeProviderServices(
	adapters: ProviderAdapterMap,
	create: <P extends ConnectionProviderId>(
		id: P,
		adapter: ProviderAdapterMap[P]
	) => unknown
): Record<ConnectionProviderId, unknown> {
	return {
		anthropic: create("anthropic", adapters.anthropic),
		google: create("google", adapters.google),
		openai: create("openai", adapters.openai),
		"opencode-go": create("opencode-go", adapters["opencode-go"]),
	};
}

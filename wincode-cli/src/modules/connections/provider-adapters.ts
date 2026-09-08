import type { ProviderAdapterDependencies } from "./provider-definition";
import { createProviderRegistry } from "./provider-registry";

export type { ProviderAdapterDependencies } from "./provider-definition";

export const createProviderAdapters = (deps: ProviderAdapterDependencies) => ({
	...createProviderRegistry(deps),
});

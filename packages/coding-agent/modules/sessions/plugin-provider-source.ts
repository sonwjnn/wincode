import type { PluginProviderSourceScope } from "@/modules/plugins/runtime";

export type SessionSdkPluginProviderSource = Readonly<{
	pluginId: string;
	providerId: string;
	sourceIdentity: string;
	sourcePath: string;
	sourceScope?: PluginProviderSourceScope;
}>;

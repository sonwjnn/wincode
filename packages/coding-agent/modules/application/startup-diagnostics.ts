import type { PluginDiagnostic } from "../plugins/runtime";

export type StartupDiagnosticsInput = Readonly<{
	pluginDiagnostics: readonly PluginDiagnostic[];
	projectTrustDiagnostics: readonly string[];
}>;

export const formatStartupDiagnostics = ({
	pluginDiagnostics,
	projectTrustDiagnostics,
}: StartupDiagnosticsInput): readonly string[] => [
	...projectTrustDiagnostics.map((message) => `Project trust: ${message}`),
	...pluginDiagnostics.map(
		({ message, sourcePath }) => `Plugin: ${message} (${sourcePath})`
	),
];

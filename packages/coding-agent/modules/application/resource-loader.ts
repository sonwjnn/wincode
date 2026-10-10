import * as os from "node:os";
import {
	loadPlugins,
	type PluginPackageReference,
} from "@/modules/plugins/loader";
import {
	createPluginRuntime,
	type PluginRuntime,
} from "@/modules/plugins/runtime";
import {
	type ProjectTrustDecision,
	resolveProjectTrust,
} from "@/modules/project-trust/project-trust";
import { resolveWorkspaceRoot } from "@/modules/tools";
import {
	type ConfigRuntime,
	createConfigStore,
} from "@/shared/config/config-store";
import type { ExecutionMode } from "@/shared/execution-mode";
import {
	resolveUserDataDir,
	resolveUserWincodeDir,
} from "@/shared/paths/user-data-dir";
import { createApplicationPluginComposition } from "./plugin-composition";

export type ApplicationResourceDiagnostic = Readonly<{
	message: string;
	resource: "project trust" | "configuration" | "Plugin";
	sourcePath?: string;
}>;

export type ApplicationResourceRuntime = Readonly<{
	configRuntime: ConfigRuntime;
	pluginRuntime: PluginRuntime;
}>;

export type ApplicationResourceReloadResult = ApplicationResourceRuntime &
	Readonly<{
		diagnostics: readonly ApplicationResourceDiagnostic[];
		pluginRuntimeChanged: boolean;
		trustChanged: boolean;
	}>;

export type ApplicationResourceLoader = Readonly<{
	/** Reloads from saved or invocation trust without prompting or persisting a decision. */
	reload: (input: {
		current: ApplicationResourceRuntime;
	}) => Promise<ApplicationResourceReloadResult>;
}>;

export type ApplicationResourceLoaderInput = Readonly<{
	cwd: string;
	disabledPluginIds: readonly string[];
	mode: ExecutionMode;
	pluginPaths: readonly string[];
	projectTrustOverride?: ProjectTrustDecision;
	stdinIsTTY: boolean;
}>;

export type ApplicationResourceLoaderOptions = Readonly<{
	configRoot?: string;
	distributionPlugins?: readonly PluginPackageReference[];
	homeRoot?: string;
	projectTrustDir?: string;
	userDataDir?: string;
}>;

const equalRoots = (
	first: readonly string[] | undefined,
	second: readonly string[]
): boolean => {
	const firstSet = new Set(first ?? []);
	const secondSet = new Set(second);
	return (
		firstSet.size === secondSet.size &&
		[...firstSet].every((root) => secondSet.has(root))
	);
};

type PluginRuntimeResolution = Pick<
	ApplicationResourceReloadResult,
	"pluginRuntime" | "pluginRuntimeChanged"
>;

const resolvePluginRuntime = async (input: {
	configRuntime: ConfigRuntime;
	current: ApplicationResourceRuntime;
	diagnostics: ApplicationResourceDiagnostic[];
	disabledPluginIds: readonly string[];
	distributionPlugins: readonly PluginPackageReference[];
	pluginPaths: readonly string[];
	trustChanged: boolean;
	userDataDir: string;
	workspace: string;
}): Promise<PluginRuntimeResolution> => {
	let pluginRuntime = input.current.pluginRuntime;
	let pluginRuntimeChanged = false;
	if (!input.trustChanged) {
		await input.current.configRuntime.configStore.refreshSnapshot(
			input.workspace
		);
	}
	try {
		const candidate = await loadPlugins({
			cliPaths: input.pluginPaths,
			config: input.configRuntime,
			disabledPluginIds: input.disabledPluginIds,
			distributionPlugins: input.distributionPlugins,
			deferProcessStart: true,
			reloadFileModules: true,
			userDataDir: input.userDataDir,
		});
		const candidateDiagnostics = candidate.diagnostics;
		const candidateHasErrors = candidateDiagnostics.some(
			({ severity }) => severity === "error"
		);
		input.diagnostics.push(
			...candidateDiagnostics.map(({ message, sourcePath }) => ({
				message,
				resource: "Plugin" as const,
				sourcePath,
			}))
		);
		if (candidateHasErrors && !input.trustChanged) {
			// This candidate is deferred and was never published or started.
			input.diagnostics.push({
				message:
					"The active Plugin set was kept because at least one replacement did not load cleanly.",
				resource: "Plugin",
			});
		} else {
			pluginRuntime = candidate;
			pluginRuntimeChanged = candidate !== input.current.pluginRuntime;
		}
	} catch (error) {
		input.diagnostics.push({
			message: error instanceof Error ? error.message : String(error),
			resource: "Plugin",
		});
		if (input.trustChanged) {
			pluginRuntime = createPluginRuntime([], []);
			pluginRuntimeChanged = true;
			input.diagnostics.push({
				message:
					"All active Plugins were unloaded because project trust changed and the replacement set could not be loaded.",
				resource: "Plugin",
			});
		}
	}
	return { pluginRuntime, pluginRuntimeChanged };
};

/**
 * Creates the application-level reload facade. Domain loaders still parse
 * their own resources; this module refreshes trust/config before asking them.
 */
export const createApplicationResourceLoader = (
	input: ApplicationResourceLoaderInput,
	options: ApplicationResourceLoaderOptions
): ApplicationResourceLoader => {
	const cwd = input.cwd;
	const homeRoot = options.homeRoot ?? os.homedir();
	const projectTrustDir =
		options.projectTrustDir ?? resolveUserWincodeDir(homeRoot);
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	const workspace = resolveWorkspaceRoot(cwd);
	const composition = createApplicationPluginComposition();
	const distributionPlugins =
		options.distributionPlugins ?? composition.distributionPlugins;
	return Object.freeze({
		reload: async ({ current }) => {
			const trust = await resolveProjectTrust({
				mode: input.mode,
				...(input.projectTrustOverride === undefined
					? {}
					: { override: input.projectTrustOverride }),
				stdinIsTTY: input.stdinIsTTY,
				projectTrustDir,
				workspace,
			});
			const configStore = createConfigStore({
				homeRoot,
				trustedProjectRoots: trust.trustedProjectRoots,
				...(options.configRoot === undefined
					? {}
					: { configRoot: options.configRoot }),
			});
			const configRuntime: ConfigRuntime = Object.freeze({
				configStore,
				cwd,
				homeRoot,
				trustedProjectRoots: trust.trustedProjectRoots,
				workspace,
			});
			const snapshot = await configStore.refreshSnapshot(workspace);
			const diagnostics: ApplicationResourceDiagnostic[] = [
				...trust.diagnostics.map((message) => ({
					message,
					resource: "project trust" as const,
				})),
				...snapshot.diagnostics.map(({ message, path: sourcePath }) => ({
					message,
					resource: "configuration" as const,
					sourcePath,
				})),
			];

			const trustChanged = !equalRoots(
				current.configRuntime.trustedProjectRoots,
				trust.trustedProjectRoots
			);
			const pluginResolution = await resolvePluginRuntime({
				configRuntime,
				current,
				diagnostics,
				disabledPluginIds: input.disabledPluginIds,
				distributionPlugins,
				pluginPaths: input.pluginPaths,
				trustChanged,
				userDataDir,
				workspace,
			});

			return Object.freeze({
				configRuntime,
				diagnostics: Object.freeze(diagnostics),
				pluginRuntime: pluginResolution.pluginRuntime,
				pluginRuntimeChanged: pluginResolution.pluginRuntimeChanged,
				trustChanged,
			});
		},
	});
};

import * as os from "node:os";
import {
	loadPlugins,
	type PluginPackageReference,
} from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	type ProjectTrustSnapshot,
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
	}>;

export type ApplicationResourceLoader = Readonly<{
	/** Reloads resources under the trust policy captured when the runtime started. */
	reload: (input: {
		current: ApplicationResourceRuntime;
	}) => Promise<ApplicationResourceReloadResult>;
}>;

export type ApplicationResourceLoaderInput = Readonly<{
	cwd: string;
	disabledPluginIds: readonly string[];
	mode: ExecutionMode;
	pluginPaths: readonly string[];
	trustSnapshot: ProjectTrustSnapshot;
}>;

export type ApplicationResourceLoaderOptions = Readonly<{
	distributionPlugins?: readonly PluginPackageReference[];
	homeRoot?: string;
	projectTrustDir?: string;
	userDataDir?: string;
}>;

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
	userDataDir: string;
	workspace: string;
}): Promise<PluginRuntimeResolution> => {
	let pluginRuntime = input.current.pluginRuntime;
	let pluginRuntimeChanged = false;
	await input.current.configRuntime.configStore.refreshSnapshot(
		input.workspace
	);
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
		if (candidateHasErrors) {
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
	}
	return { pluginRuntime, pluginRuntimeChanged };
};

/**
 * Creates the application-level reload facade. Domain loaders still parse
 * their own resources; this module refreshes config under the active trust snapshot.
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
				projectTrustDir,
				trustSnapshot: input.trustSnapshot,
				workspace,
			});
			const trustedProjectRoots = trust.trustedProjectRoots;
			const untrustedProjectRoots = trust.untrustedProjectRoots;
			const configStore = createConfigStore({
				homeRoot,
				trustedProjectRoots,
			});
			const configRuntime: ConfigRuntime = Object.freeze({
				configStore,
				cwd,
				homeRoot,
				trustedProjectRoots,
				untrustedProjectRoots,
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

			const pluginResolution = await resolvePluginRuntime({
				configRuntime,
				current,
				diagnostics,
				disabledPluginIds: input.disabledPluginIds,
				distributionPlugins,
				pluginPaths: input.pluginPaths,
				userDataDir,
				workspace,
			});

			return Object.freeze({
				configRuntime,
				diagnostics: Object.freeze(diagnostics),
				pluginRuntime: pluginResolution.pluginRuntime,
				pluginRuntimeChanged: pluginResolution.pluginRuntimeChanged,
			});
		},
	});
};

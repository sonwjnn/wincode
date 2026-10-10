import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import {
	loadPlugins,
	type PluginPackageReference,
} from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	type ProjectTrustDecision,
	type ProjectTrustOverride,
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
import {
	type ApplicationResourceLoader,
	createApplicationResourceLoader,
} from "./resource-loader";

export type ApplicationRuntimeInput = Readonly<{
	cwd: string;
	disabledPluginIds: readonly string[];
	mode: ExecutionMode;
	pluginPaths: readonly string[];
	projectTrustOverride?: ProjectTrustOverride;
	stdinIsTTY: boolean;
}>;

export type ApplicationRuntime = Readonly<{
	configRuntime: ConfigRuntime;
	pluginRuntime: PluginRuntime;
	resourceLoader: ApplicationResourceLoader;
	startupDiagnostics: readonly string[];
}>;

export type ApplicationRuntimeOptions = Readonly<{
	configRoot?: string;
	distributionPlugins?: readonly PluginPackageReference[];
	homeRoot?: string;
	projectTrustDir?: string;
	promptProjectTrust?: (projectRoot: string) => Promise<ProjectTrustDecision>;
	userDataDir?: string;
}>;

const promptProjectTrust = async (
	projectRoot: string
): Promise<ProjectTrustDecision> => {
	const terminal = createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		const answer = await terminal.question(
			`Project resources in ${projectRoot} may load Plugins and MCP Servers with Wincode's process privileges. This is not a sandbox. Trust and remember this directory? [y/N] `
		);
		return answer.trim().toLowerCase() === "y" ||
			answer.trim().toLowerCase() === "yes"
			? "trust"
			: "deny";
	} finally {
		terminal.close();
		process.stdin.resume();
	}
};

/** Composes the application runtime only after resolving Project trust. */
export const initializeApplicationRuntime = async (
	input: ApplicationRuntimeInput,
	options: ApplicationRuntimeOptions = {}
): Promise<ApplicationRuntime> => {
	const cwd = input.cwd;
	const homeRoot = options.homeRoot ?? os.homedir();
	const userDataDir = options.userDataDir ?? resolveUserDataDir();
	const projectTrustDir =
		options.projectTrustDir ?? resolveUserWincodeDir(homeRoot);
	const workspace = resolveWorkspaceRoot(cwd);
	const projectTrust = await resolveProjectTrust({
		mode: input.mode,
		...(input.projectTrustOverride === undefined
			? {}
			: { override: input.projectTrustOverride }),
		prompt: options.promptProjectTrust ?? promptProjectTrust,
		stdinIsTTY: input.stdinIsTTY,
		projectTrustDir,
		workspace,
	});
	const configStore = createConfigStore({
		homeRoot,
		trustedProjectRoots: projectTrust.trustedProjectRoots,
		...(options.configRoot === undefined
			? {}
			: { configRoot: options.configRoot }),
	});
	const configRuntime: ConfigRuntime = Object.freeze({
		configStore,
		cwd,
		homeRoot,
		trustedProjectRoots: projectTrust.trustedProjectRoots,
		workspace,
	});
	const composition = createApplicationPluginComposition();
	const pluginRuntime = await loadPlugins({
		cliPaths: input.pluginPaths,
		config: configRuntime,
		disabledPluginIds: input.disabledPluginIds,
		distributionPlugins:
			options.distributionPlugins ?? composition.distributionPlugins,
		userDataDir,
	});
	const resourceLoader = createApplicationResourceLoader(input, {
		...options,
		projectTrustDir,
		userDataDir,
	});
	return Object.freeze({
		configRuntime,
		pluginRuntime,
		resourceLoader,
		startupDiagnostics: projectTrust.diagnostics,
	});
};

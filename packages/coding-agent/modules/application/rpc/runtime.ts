import * as os from "node:os";
import {
	isSupportedThinkingLevel,
	modelSelectionSchema,
	thinkingLevelSchema,
} from "@wincode/ai/models";
import { loadPlugins } from "@/modules/plugins/loader";
import { createSessionSdkOperations } from "@/modules/sessions/sdk";
import type { SessionSdkOperations } from "@/modules/sessions/sdk-contract";
import { createConfigStore } from "@/shared/config/config-store";
import { createSessionCapabilities } from "../../../modules/sessions/host/session-capabilities";
import {
	createAgentTurnId,
	createSessionUserMessage,
	resolveWorkspaceRoot,
	toSessionId,
} from "../../../modules/sessions/host/session-rpc";
import { createApplicationPluginComposition } from "../plugin-composition";
import type { RpcCompositionInput, RuntimeModules } from "./types";

export const loadRuntime = async (
	input: Pick<
		RpcCompositionInput,
		"configRuntime" | "pluginRuntime" | "disabledPluginIds" | "pluginPaths"
	> = {}
): Promise<RuntimeModules> => ({
	createAgentTurnId,
	createSessionCapabilities: async (sessionComposition) => {
		const configStore = input.configRuntime?.configStore ?? createConfigStore();
		const pluginComposition = createApplicationPluginComposition();
		const configRuntime = input.configRuntime ?? {
			configStore,
			cwd: sessionComposition.cwd,
			homeRoot: os.homedir(),
			workspace: sessionComposition.workspace,
		};
		const pluginRuntime =
			input.pluginRuntime ??
			(await loadPlugins({
				cliPaths: input.pluginPaths ?? [],
				config: configRuntime,
				disabledPluginIds: input.disabledPluginIds ?? [],
				distributionPlugins: pluginComposition.distributionPlugins,
			}));
		let sessionSdk: SessionSdkOperations | undefined;
		const assembly = await createSessionCapabilities({
			configStore,
			cwd: sessionComposition.cwd,
			configRuntime,
			getSessionSdk: () => sessionSdk,
			pluginRuntime,
			turnToolResolver: pluginComposition.turnToolResolver,
			workspace: sessionComposition.workspace,
		});
		sessionSdk = createSessionSdkOperations(
			{
				configRuntime,
				connections: assembly.capabilities.getConnections(),
				cwd: sessionComposition.cwd,
				registry: assembly.capabilities.getRegistry(),
				store: assembly.store,
				workspace: sessionComposition.workspace,
			},
			assembly.capabilities.getSessionHostManager(),
			assembly.store
		);
		return assembly;
	},

	createSessionHost: (sessionInput) =>
		sessionInput.capabilities.getSessionHostManager().openHost({
			...sessionInput,
			executionMode: "rpc",
			view: true,
		}),
	createSessionUserMessage,
	isSupportedThinkingLevel,
	modelSelectionSchema,
	thinkingLevelSchema,
	resolveWorkspaceRoot,
	toSessionId,
});

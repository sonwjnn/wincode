import * as os from "node:os";
import {
	effortSchema,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	modelSelectionSchema,
	reasoningModeSchema,
} from "@wincode/ai/models";
import { loadPlugins } from "@/modules/plugins/loader";
import { createSessionSdkChildFactory } from "@/modules/sessions/sdk";
import type { SessionSdkChildFactory } from "@/modules/sessions/sdk-contract";
import { createConfigStore } from "@/shared/config/config-store";
import { createPermissionService } from "../../../modules/permissions/permission-service";
import { createSessionCapabilities } from "../../../modules/sessions/host/session-capabilities";
import {
	createAgentTurnId,
	createSessionUserMessage,
	resolveWorkspaceRoot,
	toSessionId,
} from "../../../modules/sessions/host/session-rpc";
import type { OptionalApplicationPluginId } from "../plugin-composition";
import { createApplicationPluginComposition } from "../plugin-composition";
import type { RpcCompositionInput, RuntimeModules } from "./types";

export const loadRuntime = async (
	input: Pick<RpcCompositionInput, "configRuntime" | "pluginRuntime"> &
		Readonly<{ enabledPlugins?: readonly OptionalApplicationPluginId[] }> = {}
): Promise<RuntimeModules> => ({
	createAgentTurnId,
	createSessionCapabilities: async (sessionComposition) => {
		const configStore = input.configRuntime?.configStore ?? createConfigStore();
		const pluginComposition = createApplicationPluginComposition({
			configStore,
			createMcpResource: input.pluginRuntime === undefined,
			enabledPlugins: input.enabledPlugins ?? ["mcp", "subagents"],
			workspace: sessionComposition.workspace,
		});
		const configRuntime = input.configRuntime ?? {
			configStore,
			cwd: sessionComposition.cwd,
			homeRoot: os.homedir(),
			workspace: sessionComposition.workspace,
		};
		const pluginRuntime =
			input.pluginRuntime ??
			(await loadPlugins({
				bundledPlugins: pluginComposition.bundledPlugins,
				cliPaths: [],
				config: configRuntime,
			}));
		let sessionSdk: SessionSdkChildFactory | undefined;
		const assembly = await createSessionCapabilities({
			configStore,
			cwd: sessionComposition.cwd,
			configRuntime,
			getSessionSdk: () => sessionSdk,
			pluginRuntime,
			turnToolResolver: pluginComposition.turnToolResolver,
			permissionService: createPermissionService({
				autoApproval: sessionComposition.autoApproval,
			}),
			workspace: sessionComposition.workspace,
		});
		sessionSdk = createSessionSdkChildFactory(
			{
				configRuntime,
				connections: assembly.capabilities.getConnections(),
				cwd: sessionComposition.cwd,
				enabledPlugins: input.enabledPlugins ?? ["mcp", "subagents"],
				permissionService: createPermissionService({
					autoApproval: sessionComposition.autoApproval,
				}),
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
	effortSchema,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	modelSelectionSchema,
	reasoningModeSchema,
	resolveWorkspaceRoot,
	toSessionId,
});

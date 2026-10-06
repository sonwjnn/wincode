import {
	effortSchema,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	modelSelectionSchema,
	reasoningModeSchema,
} from "@wincode/ai/models";
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
			enabledPlugins: input.enabledPlugins ?? ["mcp", "subagents"],
			workspace: sessionComposition.workspace,
		});
		return createSessionCapabilities({
			configStore,
			cwd: sessionComposition.cwd,
			...(input.configRuntime === undefined
				? {}
				: { configRuntime: input.configRuntime }),
			...(input.pluginRuntime === undefined
				? {}
				: { pluginRuntime: input.pluginRuntime }),
			...(pluginComposition.mcpResource === undefined
				? {}
				: { mcpResource: pluginComposition.mcpResource }),
			...(pluginComposition.createDelegationAdapter === undefined
				? {}
				: {
						createDelegationAdapter: pluginComposition.createDelegationAdapter,
					}),
			...(pluginComposition.createDelegationRuntime === undefined
				? {}
				: {
						createDelegationRuntime: pluginComposition.createDelegationRuntime,
					}),
			turnToolResolver: pluginComposition.turnToolResolver,
			permissionService: createPermissionService({
				autoApproval: sessionComposition.autoApproval,
			}),
			workspace: sessionComposition.workspace,
		});
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

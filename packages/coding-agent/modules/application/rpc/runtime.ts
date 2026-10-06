import {
	effortSchema,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	modelSelectionSchema,
	reasoningModeSchema,
} from "@wincode/ai/models";
import { createPermissionService } from "../../../modules/permissions/permission-service";
import { createSessionCapabilities } from "../../../modules/sessions/host/session-capabilities";
import {
	createAgentTurnId,
	createSessionUserMessage,
	resolveWorkspaceRoot,
	toSessionId,
} from "../../../modules/sessions/host/session-rpc";
import type { RpcCompositionInput, RuntimeModules } from "./types";

export const loadRuntime = async (
	input: Pick<RpcCompositionInput, "configRuntime" | "pluginRuntime"> = {}
): Promise<RuntimeModules> => ({
	createAgentTurnId,
	createSessionCapabilities: (composition) =>
		createSessionCapabilities({
			cwd: composition.cwd,
			...(input.configRuntime === undefined
				? {}
				: { configRuntime: input.configRuntime }),
			...(input.pluginRuntime === undefined
				? {}
				: { pluginRuntime: input.pluginRuntime }),
			permissionService: createPermissionService({
				autoApproval: composition.autoApproval,
			}),
			workspace: composition.workspace,
		}),
	createSessionHost: (input) =>
		input.capabilities.getSessionHostManager().openHost({
			...input,
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

import {
	isSupportedThinkingLevel,
	modelSelectionSchema,
	thinkingLevelSchema,
} from "@wincode/ai/models";
import {
	createAgentTurnId,
	createSessionUserMessage,
	resolveWorkspaceRoot,
	toSessionId,
} from "../../../modules/sessions/host/session-rpc";
import { openApplicationSessionEnvironment } from "../plugin-composition";
import type { RpcCompositionInput, RuntimeModules } from "./types";

export const loadRuntime = async (
	input: Pick<
		RpcCompositionInput,
		"configRuntime" | "pluginRuntime" | "disabledPluginIds" | "pluginPaths"
	> = {}
): Promise<RuntimeModules> => ({
	createAgentTurnId,
	openSessionEnvironment: (sessionComposition) =>
		openApplicationSessionEnvironment({
			...input,
			cwd: sessionComposition.cwd,
			workspace: sessionComposition.workspace,
		}),

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

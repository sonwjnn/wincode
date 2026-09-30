import {
	effortSchema,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	modelSelectionSchema,
	reasoningModeSchema,
} from "@wincode/ai/models";
import { createPermissionService } from "../../../modules/permissions/permission-service";
import { createSessionCapabilities } from "../../../modules/sessions/host/session-capabilities";
import { createSessionHost } from "../../../modules/sessions/host/session-host";
import {
	createAgentTurnId,
	createSessionUserMessage,
	resolveWorkspaceRoot,
	toSessionId,
} from "../../../modules/sessions/host/session-rpc";
import type { RuntimeModules } from "./types";

export const loadRuntime = async (): Promise<RuntimeModules> => ({
	createAgentTurnId,
	createSessionCapabilities: (input) =>
		createSessionCapabilities({
			cwd: input.cwd,
			permissionService: createPermissionService({
				autoApproval: input.autoApproval,
			}),
			workspace: input.workspace,
		}),
	createSessionHost: (input) =>
		createSessionHost({ ...input, executionMode: "rpc" }),
	createSessionUserMessage,
	effortSchema,
	isSupportedModelEffort,
	isSupportedReasoningMode,
	modelSelectionSchema,
	reasoningModeSchema,
	resolveWorkspaceRoot,
	toSessionId,
});

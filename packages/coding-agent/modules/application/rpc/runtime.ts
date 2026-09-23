import { createPermissionService } from "../../../modules/permissions/permission-service";
import { createSessionCapabilities } from "../../../modules/sessions/host/session-capabilities";
import { createSessionHost } from "../../../modules/sessions/host/session-host";
import {
	createAgentTurnId,
	createSessionUserMessage,
	isSupportedModelVariant,
	modelSelectionSchema,
	normalizeModelVariant,
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
	createSessionHost,
	createSessionUserMessage,
	isSupportedModelVariant,
	modelSelectionSchema,
	normalizeModelVariant,
	resolveWorkspaceRoot,
	toSessionId,
});

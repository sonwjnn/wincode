import { createPermissionService } from "../../../modules/permissions/permission-service";
import type { RuntimeModules } from "./types";

export const loadRuntime = async (): Promise<RuntimeModules> => {
	const [capabilities, host, rpc] = await Promise.all([
		import("../../../modules/sessions/host/session-capabilities"),
		import("../../../modules/sessions/host/session-host"),
		import("../../../modules/sessions/host/session-rpc"),
	]);
	return {
		createAgentTurnId: rpc.createAgentTurnId,
		createSessionCapabilities: (input) =>
			capabilities.createSessionCapabilities({
				cwd: input.cwd,
				permissionService: createPermissionService({
					autoApproval: input.autoApproval,
				}),
				workspace: input.workspace,
			}),
		createSessionHost: host.createSessionHost,
		createSessionUserMessage: rpc.createSessionUserMessage,
		isSupportedModelVariant: rpc.isSupportedModelVariant,
		modelSelectionSchema: rpc.modelSelectionSchema,
		normalizeModelVariant: rpc.normalizeModelVariant,
		resolveWorkspaceRoot: rpc.resolveWorkspaceRoot,
		toSessionId: rpc.toSessionId,
	};
};

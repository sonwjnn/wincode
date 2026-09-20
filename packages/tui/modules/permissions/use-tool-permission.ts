import { useMemo, useState } from "react";
import { useAgentRegistry } from "@/modules/agents/agent-registry-provider";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useConfig } from "@/shared/config/config-provider";
import { usePermissionService } from "./permission-service-provider";
import type { ToolPermissionRuntime } from "./tool-permission-runtime";
import {
	createToolPermissionPolicyState,
	createToolPermissionRuntime,
} from "./tool-permission-runtime";

/**
 * Binds the React-free Tool Permission runtime to the providers that supply
 * its inputs: the prompt config's active Agent, the Agent registry, the
 * workspace sandbox root, and the permission service. It composes no policy of
 * its own — the runtime module owns every resolution.
 */
export function useToolPermission(): ToolPermissionRuntime {
	const config = useConfig();
	const service = usePermissionService();
	const { agent } = usePromptConfig();
	const registry = useAgentRegistry();
	const [policyState] = useState(createToolPermissionPolicyState);
	return useMemo(
		() =>
			createToolPermissionRuntime({
				agent,
				policyState,
				registry,
				service,
				workspace: config.workspace,
			}),
		[agent, config.workspace, policyState, registry, service]
	);
}

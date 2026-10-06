import * as os from "node:os";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { createConnections } from "@wincode/ai/connections";
import { useEffect, useReducer } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { createApplicationPluginComposition } from "@/modules/application/plugin-composition";
import { ConnectionsProvider } from "@/modules/connections";
import { McpProvider } from "@/modules/mcp";
import { ModelPricingProvider } from "@/modules/model-pricing";
import {
	createPermissionService,
	PermissionServiceProvider,
} from "@/modules/permissions";
import { getInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import { CopyOnSelectFromSettings } from "@/modules/settings";
import { resolveWorkspaceRoot } from "@/modules/tools";
import { parseCliOptions } from "@/shared/cli-options";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import { ApprovalPanelsProvider } from "@/shared/providers/approval/approval-panels-provider";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import { getInteractiveRuntimeContext } from "@/shared/runtime-context";
import { setInteractiveCleanup } from "@/shared/runtime-lifecycle";
import { CommandControllerProvider } from "../commands/command-controller-provider";
import { SettingsProviders } from "./settings-providers";

const interactiveRuntime = getInteractiveRuntimeContext();
const { args, cwd, pluginRuntime } = interactiveRuntime;
const connections = createConnections();
const workspace =
	interactiveRuntime.configRuntime?.workspace ?? resolveWorkspaceRoot(cwd);
const configStore =
	interactiveRuntime.configRuntime?.configStore ?? createConfigStore();
const configContext =
	interactiveRuntime.configRuntime ??
	Object.freeze({
		configStore,
		cwd,
		homeRoot: os.homedir(),
		workspace,
	});
const cliOptions = parseCliOptions(args);
const applicationPlugins = createApplicationPluginComposition({
	configStore,
	enabledPlugins: (["mcp", "subagents"] as const).filter(
		(pluginId) => !cliOptions.disabledPlugins.includes(pluginId)
	),
	workspace,
});
const mcpResource = applicationPlugins.mcpResource;
if (mcpResource === undefined) {
	throw new Error("The selected MCP Plugin did not provide its resource.");
}
const permissionService = createPermissionService(cliOptions);
setInteractiveCleanup(async () => {
	try {
		await getInteractiveSessionHostManager(
			applicationPlugins.createDelegationRuntime,
			pluginRuntime
		).shutdownAll();
	} finally {
		try {
			await pluginRuntime?.shutdown();
		} finally {
			await mcpResource.close();
		}
	}
});

export function RootLayout() {
	const router = useRouter();
	const [, forceUpdate] = useReducer((x) => x + 1, 0);
	const currentPath = useRouterState({ select: (s) => s.location.pathname });
	useEffect(() => {
		const update = () => setTimeout(forceUpdate, 0);
		const before = router.subscribe("onBeforeLoad", update);
		const resolved = router.subscribe("onResolved", update);
		return () => {
			before();
			resolved();
		};
	}, [router]);
	return (
		<ConfigProvider value={configContext}>
			<ToastProvider>
				<ConnectionsProvider connections={connections}>
					<PermissionServiceProvider service={permissionService}>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<ApprovalPanelsProvider>
									<SettingsProviders>
										<ModelPricingProvider>
											<DialogProvider>
												<McpProvider
													closeRegistryOnUnmount={false}
													refreshKey={currentPath}
													resource={mcpResource}
												>
													<CopyOnSelectFromSettings />
													<DialogProvider>
														<CommandControllerProvider>
															<Outlet key={currentPath} />
														</CommandControllerProvider>
													</DialogProvider>
												</McpProvider>
											</DialogProvider>
										</ModelPricingProvider>
									</SettingsProviders>
								</ApprovalPanelsProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</PermissionServiceProvider>
				</ConnectionsProvider>
			</ToastProvider>
		</ConfigProvider>
	);
}

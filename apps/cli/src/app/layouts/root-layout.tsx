import { homedir } from "node:os";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { resolveWorkspaceRoot } from "@wincode/coding-tools/workspace";
import { useEffect, useReducer } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { ConnectionsProvider, createConnections } from "@/modules/connections";
import { createMcpRegistry, McpProvider } from "@/modules/mcp";
import { ModelPricingProvider } from "@/modules/model-pricing";
import {
	createPermissionService,
	PermissionServiceProvider,
} from "@/modules/permissions";
import { PromptConfigProvider } from "@/modules/prompt-settings/context/prompt-config-provider";
import { parseCliOptions } from "@/shared/cli-options";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import { ApprovalPanelsProvider } from "@/shared/providers/approval/approval-panels-provider";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";

const connections = createConnections();
const workspace = resolveWorkspaceRoot(process.cwd());
const configStore = createConfigStore();
const configContext = Object.freeze({
	configStore,
	homeRoot: homedir(),
	workspace,
});
const mcpRegistry = createMcpRegistry({ configStore, workspace });
const permissionService = createPermissionService(
	parseCliOptions(process.argv)
);

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
									<PromptConfigProvider>
										<ModelPricingProvider>
											<DialogProvider>
												<McpProvider
													closeRegistryOnUnmount={false}
													createRegistry={() => mcpRegistry}
													refreshKey={currentPath}
													workspace={workspace}
												>
													<CopyOnSelect />
													<DialogProvider>
														<Outlet key={currentPath} />
													</DialogProvider>
												</McpProvider>
											</DialogProvider>
										</ModelPricingProvider>
									</PromptConfigProvider>
								</ApprovalPanelsProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</PermissionServiceProvider>
				</ConnectionsProvider>
			</ToastProvider>
		</ConfigProvider>
	);
}

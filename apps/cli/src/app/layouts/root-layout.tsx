import { homedir } from "node:os";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { getChatModelRoute } from "@wincode/ai";
import { type ReactNode, useEffect, useReducer } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { BillingProvider } from "@/modules/billing";
import { ConnectionsProvider, createConnections } from "@/modules/connections";
import { createMcpRegistry, McpProvider } from "@/modules/mcp";
import { ModelPricingProvider } from "@/modules/model-pricing";
import {
	createPermissionService,
	PermissionServiceProvider,
} from "@/modules/permissions";
import {
	PromptConfigProvider,
	usePromptConfig,
} from "@/modules/prompt-settings/context/prompt-config-provider";
import { parseCliOptions } from "@/shared/cli-options";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";

const connections = createConnections();
const workspace = process.cwd();
const configStore = createConfigStore();
const configContext = Object.freeze({
	configStore,
	homeRoot: homedir(),
	workspace,
});
// Process-lifetime infrastructure is composed once and injected into modules.
const mcpRegistry = createMcpRegistry({ configStore, workspace });
// The Permission service is workspace- and process-scoped: one instance owns the
// in-memory temporary grants and auto-approval flag shared across every Agent and
// conversation. Auto approval starts enabled only when launched with `--auto`.
const permissionService = createPermissionService(
	parseCliOptions(process.argv)
);

function BillingComposition({ children }: { children: ReactNode }) {
	const { model } = usePromptConfig();
	return (
		<BillingProvider enabled={getChatModelRoute(model) === "hosted"}>
			{children}
		</BillingProvider>
	);
}

export function RootLayout() {
	const router = useRouter();
	const [, forceUpdate] = useReducer((x) => x + 1, 0);

	const currentPath = useRouterState({
		select: (s) => s.location.pathname,
	});

	useEffect(() => {
		const updateAfterLoadStarts = () => {
			setTimeout(forceUpdate, 0);
		};

		const unsubscribeBeforeLoad = router.subscribe("onBeforeLoad", () => {
			updateAfterLoadStarts();
		});
		const unsubscribeResolved = router.subscribe("onResolved", () => {
			updateAfterLoadStarts();
		});

		return () => {
			unsubscribeBeforeLoad();
			unsubscribeResolved();
		};
	}, [router]);

	return (
		<ConfigProvider value={configContext}>
			<ToastProvider>
				<ConnectionsProvider connections={connections}>
					<PermissionServiceProvider service={permissionService}>
						<AgentRegistryProvider>
							<KeyboardLayerProvider>
								<PromptConfigProvider>
									<ModelPricingProvider>
										<BillingComposition>
											<DialogProvider>
												<McpProvider
													createRegistry={() => mcpRegistry}
													workspace={workspace}
												>
													<CopyOnSelect />
													{/*
													 * The McpProvider renders the approval dialog through the
													 * outer DialogProvider (it must sit below a DialogProvider),
													 * while app dialogs mount through this inner DialogProvider so
													 * dialog content can consume useMcp (status dialog, approvals
													 * opened by the command executor).
													 */}
													<DialogProvider>
														<Outlet key={currentPath} />
													</DialogProvider>
												</McpProvider>
											</DialogProvider>
										</BillingComposition>
									</ModelPricingProvider>
								</PromptConfigProvider>
							</KeyboardLayerProvider>
						</AgentRegistryProvider>
					</PermissionServiceProvider>
				</ConnectionsProvider>
			</ToastProvider>
		</ConfigProvider>
	);
}

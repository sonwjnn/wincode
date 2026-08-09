import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { getChatModelRoute } from "@wincode/ai";
import { type ReactNode, useEffect, useReducer } from "react";
import { BillingProvider } from "@/modules/billing";
import { ConnectionsProvider, createConnections } from "@/modules/connections";
import { createMcpRegistry, McpProvider } from "@/modules/mcp";
import { ModelPricingProvider } from "@/modules/model-pricing";
import {
	PromptConfigProvider,
	usePromptConfig,
} from "@/modules/prompt-settings/context/prompt-config-provider";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { createConfigStore } from "@/shared/config/config-store";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";

const connections = createConnections();
const workspace = process.cwd();
const configStore = createConfigStore();
// Process-lifetime infrastructure is composed once and injected into modules.
const mcpRegistry = createMcpRegistry({ configStore, workspace });

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
		<ConnectionsProvider connections={connections}>
			<KeyboardLayerProvider>
				<PromptConfigProvider>
					<ModelPricingProvider>
						<BillingComposition>
							<ToastProvider>
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
							</ToastProvider>
						</BillingComposition>
					</ModelPricingProvider>
				</PromptConfigProvider>
			</KeyboardLayerProvider>
		</ConnectionsProvider>
	);
}

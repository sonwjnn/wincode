import * as os from "node:os";
import { Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { createConnections } from "@wincode/ai/connections";
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { AgentRegistryProvider } from "@/modules/agents";
import { ConnectionsProvider } from "@/modules/connections";
import { ModelPricingProvider } from "@/modules/model-pricing";
import { getInteractiveSessionHostManager } from "@/modules/sessions/host/session-host-manager";
import { CopyOnSelectFromSettings } from "@/modules/settings";
import { resolveWorkspaceRoot } from "@/modules/tools";
import { ConfigProvider } from "@/shared/config/config-provider";
import { createConfigStore } from "@/shared/config/config-store";
import { DialogProvider } from "@/shared/providers/dialog/dialog-provider";
import { KeyboardLayerProvider } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { ToastProvider } from "@/shared/providers/toast/toast-provider";
import {
	getInteractiveRuntimeContext,
	getInteractiveRuntimeRevision,
	subscribeInteractiveRuntimeContext,
} from "@/shared/runtime-context";
import { setInteractiveCleanup } from "@/shared/runtime-lifecycle";
import { CommandControllerProvider } from "../commands/command-controller-provider";
import { SettingsProviders } from "./settings-providers";

const initialRuntime = getInteractiveRuntimeContext();
const connections = createConnections();

const defaultConfigContext = (() => {
	const cwd = initialRuntime.cwd;
	const workspace = resolveWorkspaceRoot(cwd);
	const configStore = createConfigStore();
	return Object.freeze({
		configStore,
		cwd,
		homeRoot: os.homedir(),
		workspace,
	});
})();

setInteractiveCleanup(async () => {
	const interactiveRuntime = getInteractiveRuntimeContext();
	try {
		await getInteractiveSessionHostManager(
			interactiveRuntime.pluginRuntime
		).shutdownAll();
	} finally {
		await interactiveRuntime.pluginRuntime?.shutdown();
	}
});

export function RootLayout() {
	const interactiveRuntime = useSyncExternalStore(
		subscribeInteractiveRuntimeContext,
		getInteractiveRuntimeContext,
		getInteractiveRuntimeContext
	);
	const runtimeRevision = useSyncExternalStore(
		subscribeInteractiveRuntimeContext,
		getInteractiveRuntimeRevision,
		getInteractiveRuntimeRevision
	);
	const router = useRouter();
	const [, forceUpdate] = useReducer((x) => x + 1, 0);
	const currentPath = useRouterState({ select: (s) => s.location.pathname });
	const configContext =
		interactiveRuntime.configRuntime ?? defaultConfigContext;
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
					<AgentRegistryProvider>
						<KeyboardLayerProvider>
							<SettingsProviders>
								<ModelPricingProvider>
									<DialogProvider>
										<CopyOnSelectFromSettings />
										<DialogProvider>
											<CommandControllerProvider>
												<Outlet key={`${currentPath}:${runtimeRevision}`} />
											</CommandControllerProvider>
										</DialogProvider>
									</DialogProvider>
								</ModelPricingProvider>
							</SettingsProviders>
						</KeyboardLayerProvider>
					</AgentRegistryProvider>
				</ConnectionsProvider>
			</ToastProvider>
		</ConfigProvider>
	);
}

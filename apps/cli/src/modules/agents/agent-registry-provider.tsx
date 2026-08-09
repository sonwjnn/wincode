import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useConfig } from "@/shared/config/config-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import {
	type AgentRegistry,
	resolveAgentRegistry,
	summarizeAgentDiagnostics,
} from "./registry";

const AgentRegistryContext = createContext<AgentRegistry | null>(null);
const storesWithDiagnosticsToast = new WeakSet<object>();

export const claimAgentDiagnosticsToast = (configStore: object): boolean => {
	if (storesWithDiagnosticsToast.has(configStore)) {
		return false;
	}
	storesWithDiagnosticsToast.add(configStore);
	return true;
};

/**
 * Loads the process-lifetime Agent Registry from the shared ConfigRuntime.
 * Config changes require a restart; resolution is memoized by the ConfigStore
 * snapshot, so the provider stays immutable once loaded.
 */
export function AgentRegistryProvider({ children }: { children: ReactNode }) {
	const config = useConfig();
	const toast = useToast();
	const [registry, setRegistry] = useState<AgentRegistry | null>(null);

	useEffect(() => {
		let ignore = false;
		resolveAgentRegistry(config)
			.then((resolved) => {
				if (!ignore) {
					setRegistry(resolved);
				}
			})
			.catch(() => undefined);
		return () => {
			ignore = true;
		};
	}, [config]);

	useEffect(() => {
		if (
			registry === null ||
			registry.diagnostics.length === 0 ||
			!claimAgentDiagnosticsToast(config.configStore)
		) {
			return;
		}
		toast.show({
			message: summarizeAgentDiagnostics(registry.diagnostics),
			variant: registry.diagnostics.some(({ severity }) => severity === "error")
				? "error"
				: "info",
		});
	}, [config.configStore, registry, toast]);

	return (
		<AgentRegistryContext.Provider value={registry}>
			{children}
		</AgentRegistryContext.Provider>
	);
}

export function useAgentRegistry(): AgentRegistry | null {
	return useContext(AgentRegistryContext);
}

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useConnections } from "@/modules/connections";
import { useConfig } from "@/shared/config/config-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import {
	type AgentRegistry,
	resolveAgentRegistry,
	summarizeAgentDiagnostics,
} from "./registry";

type AgentRegistryContextValue = {
	readonly refresh: () => void;
	readonly registry: AgentRegistry | null;
};

const AgentRegistryContext = createContext<AgentRegistryContextValue | null>(
	null
);
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
	const connections = useConnections();
	const toast = useToast();
	const [registry, setRegistry] = useState<AgentRegistry | null>(null);
	const [revision, setRevision] = useState(0);
	const refresh = useCallback(() => setRevision((current) => current + 1), []);

	useEffect(() => {
		let ignore = false;
		const resolveCurrentRegistry = async (
			_refreshRevision: number
		): Promise<AgentRegistry> => {
			const providers = await connections.listProviders();
			return resolveAgentRegistry(config, {
				connectedProviderIds: new Set(
					providers.filter(({ connected }) => connected).map(({ id }) => id)
				),
			});
		};
		resolveCurrentRegistry(revision)
			.then((resolved) => {
				if (!ignore) {
					setRegistry(resolved);
				}
			})
			.catch(() => undefined);
		return () => {
			ignore = true;
		};
	}, [config, connections, revision]);

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

	const value = useMemo(() => ({ refresh, registry }), [refresh, registry]);

	return (
		<AgentRegistryContext.Provider value={value}>
			{children}
		</AgentRegistryContext.Provider>
	);
}

export function useAgentRegistry(): AgentRegistry | null {
	const context = useContext(AgentRegistryContext);
	if (context === null) {
		throw new Error(
			"useAgentRegistry must be used within AgentRegistryProvider"
		);
	}
	return context.registry;
}

export function useRefreshAgentRegistry(): () => void {
	const context = useContext(AgentRegistryContext);
	if (context === null) {
		throw new Error(
			"useRefreshAgentRegistry must be used within AgentRegistryProvider"
		);
	}
	return context.refresh;
}

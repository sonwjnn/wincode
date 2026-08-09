import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { useConfig } from "@/shared/config/config-provider";
import { type AgentRegistry, resolveAgentRegistry } from "./registry";

const AgentRegistryContext = createContext<AgentRegistry | null>(null);

/**
 * Loads the process-lifetime Agent Registry from the shared ConfigRuntime.
 * Config changes require a restart; resolution is memoized by the ConfigStore
 * snapshot, so the provider stays immutable once loaded.
 */
export function AgentRegistryProvider({ children }: { children: ReactNode }) {
	const config = useConfig();
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

	return (
		<AgentRegistryContext.Provider value={registry}>
			{children}
		</AgentRegistryContext.Provider>
	);
}

export function useAgentRegistry(): AgentRegistry | null {
	return useContext(AgentRegistryContext);
}

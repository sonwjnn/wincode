import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useReducer,
} from "react";
import type { PermissionService } from "./permission-service";

const PermissionServiceContext = createContext<PermissionService | null>(null);

type PermissionServiceProviderProps = {
	service: PermissionService;
	children: ReactNode;
};

/**
 * Provides the process-lifetime, workspace-scoped Permission service to the tree
 * so every conversation and Agent resolves approvals, temporary grants, and auto
 * approval through the same shared state.
 */
export function PermissionServiceProvider({
	service,
	children,
}: PermissionServiceProviderProps) {
	return (
		<PermissionServiceContext.Provider value={service}>
			{children}
		</PermissionServiceContext.Provider>
	);
}

export function usePermissionService(): PermissionService {
	const service = useContext(PermissionServiceContext);
	if (service === null) {
		throw new Error(
			"usePermissionService must be used within a PermissionServiceProvider"
		);
	}
	return service;
}

/**
 * Subscribes the calling component to grant and auto-approval changes, returning
 * the service. Use this when rendering live grant lists or the auto indicator so
 * the view re-renders whenever the shared state mutates.
 */
export function useWatchedPermissionService(): PermissionService {
	const service = usePermissionService();
	const [, forceUpdate] = useReducer((count: number) => count + 1, 0);
	useEffect(() => service.subscribe(forceUpdate), [service]);
	return service;
}

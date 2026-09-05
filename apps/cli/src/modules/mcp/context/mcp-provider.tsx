import type { AgentId } from "@wincode/agent-core";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useToast } from "@/shared/providers/toast/toast-provider";
import {
	createMcpRegistry,
	type McpAgentPolicy,
	type McpCatalogSnapshot,
	type McpRegistry,
	type McpRegistryDeps,
	type McpServerStatus,
} from "../registry";
import type { McpNormalizedResult } from "../result";

export type McpContextValue = {
	close(): Promise<void>;
	initialize(): Promise<void>;
	isLoading: boolean;
	createSnapshot(
		agent: AgentId,
		agentPolicy?: McpAgentPolicy,
		trackLatest?: boolean
	): Promise<McpCatalogSnapshot>;
	execute?(
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<McpNormalizedResult>;
	releaseSnapshot?(snapshot: McpCatalogSnapshot): void;
	reconnect(serverName: string): Promise<void>;
	statuses: readonly McpServerStatus[];
	toggle(serverName: string): Promise<void>;
};

/**
 * Builds the one-time startup failure summary for a build catalog. Successful
 * connections remain visible in the sidebar without producing a toast.
 */
export function buildMcpSummary(
	statuses: readonly McpServerStatus[]
): string | null {
	const failures: string[] = [];
	for (const status of statuses) {
		if (status.state === "failed") {
			failures.push(`${status.name}: ${status.error ?? "Connection failed"}`);
		}
	}
	if (failures.length === 0) {
		return null;
	}
	return `MCP failed:\n${failures.join("\n")}`;
}

const McpContext = createContext<McpContextValue | null>(null);

export function useMcp(): McpContextValue {
	const value = useContext(McpContext);
	if (!value) {
		throw new Error("useMcp must be used within an McpProvider");
	}
	return value;
}

export type McpProviderProps = {
	children: ReactNode;
	closeRegistryOnUnmount?: boolean;
	createRegistry?: (deps: McpRegistryDeps) => McpRegistry;
	refreshKey?: string;
	workspace: string;
};

export function McpProvider({
	children,
	closeRegistryOnUnmount = true,
	createRegistry,
	refreshKey,
	workspace,
}: McpProviderProps) {
	const toast = useToast();
	const [registry] = useState<McpRegistry>(() =>
		(createRegistry ?? createMcpRegistry)({ workspace })
	);
	const summaryToastShownRef = useRef(false);
	const initializeCountRef = useRef(0);
	const [isLoading, setIsLoading] = useState(true);
	const runWithLoading = useCallback(
		async (operation: () => Promise<void>): Promise<void> => {
			initializeCountRef.current += 1;
			setIsLoading(true);
			try {
				await operation();
			} finally {
				initializeCountRef.current -= 1;
				if (initializeCountRef.current === 0) {
					setIsLoading(false);
				}
			}
		},
		[]
	);
	const initialize = useCallback(async (): Promise<void> => {
		await runWithLoading(async () => {
			try {
				await registry.initialize();
				const summary = buildMcpSummary(registry.getStatuses());
				if (summary !== null) {
					summaryToastShownRef.current = true;
					toast.show({ message: summary, variant: "error" });
				}
			} catch (error) {
				toast.show({ message: "MCP refresh failed.", variant: "error" });
				throw error;
			}
		});
	}, [registry, runWithLoading, toast.show]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey intentionally retriggers config reconciliation.
	useEffect(() => {
		void initialize().catch(() => undefined);
	}, [initialize, refreshKey]);

	useEffect(
		() => () => {
			if (closeRegistryOnUnmount) {
				void registry.close();
			}
		},
		[closeRegistryOnUnmount, registry]
	);
	const createSnapshot = useCallback(
		async (
			agent: AgentId,
			agentPolicy?: McpAgentPolicy,
			trackLatest = true
		): Promise<McpCatalogSnapshot> => {
			const snapshot = await registry.createSnapshot(
				agent,
				agentPolicy,
				trackLatest
			);
			if (agent === "build" && !summaryToastShownRef.current) {
				const summary = buildMcpSummary(registry.getStatuses());
				if (summary !== null) {
					summaryToastShownRef.current = true;
					toast.show({ message: summary, variant: "error" });
				}
			}
			return snapshot;
		},
		[registry, toast.show]
	);

	const statusesCacheRef = useRef<readonly McpServerStatus[] | null>(null);

	// `registry.getStatuses()` builds a fresh array on every call. useSyncExternalStore
	// requires a stable snapshot between notifications. Invalidate the cache before
	// notifying React so every registry emission produces a fresh snapshot.
	const subscribeStatuses = useCallback(
		(listener: () => void): (() => void) =>
			registry.subscribe(() => {
				statusesCacheRef.current = null;
				listener();
			}),
		[registry]
	);

	const getStatusesSnapshot = useCallback((): readonly McpServerStatus[] => {
		if (statusesCacheRef.current === null) {
			statusesCacheRef.current = registry.getStatuses();
		}
		return statusesCacheRef.current;
	}, [registry]);

	const statuses = useSyncExternalStore(
		subscribeStatuses,
		getStatusesSnapshot,
		getStatusesSnapshot
	);
	const showActionFailure = useCallback(
		(serverName: string): void => {
			statusesCacheRef.current = null;
			const status = getStatusesSnapshot().find(
				(item) => item.name === serverName
			);
			const summary = status === undefined ? null : buildMcpSummary([status]);
			if (summary !== null) {
				toast.show({
					message: summary,
					variant: "error",
				});
			}
		},
		[getStatusesSnapshot, toast.show]
	);
	const reconnect = useCallback(
		async (serverName: string): Promise<void> => {
			await runWithLoading(() => registry.reconnect(serverName));
			showActionFailure(serverName);
		},
		[registry, runWithLoading, showActionFailure]
	);
	const toggle = useCallback(
		async (serverName: string): Promise<void> => {
			await runWithLoading(() => registry.toggle(serverName));
			showActionFailure(serverName);
		},
		[registry, runWithLoading, showActionFailure]
	);

	const value = useMemo<McpContextValue>(
		() => ({
			close: () => registry.close(),
			createSnapshot,
			execute: (snapshot, toolName, input, signal) =>
				registry.execute(snapshot, toolName, input, signal),
			releaseSnapshot: (snapshot) => registry.releaseSnapshot?.(snapshot),
			initialize,
			isLoading,
			reconnect,
			statuses,
			toggle,
		}),
		[
			createSnapshot,
			initialize,
			isLoading,
			reconnect,
			registry,
			statuses,
			toggle,
		]
	);

	return <McpContext.Provider value={value}>{children}</McpContext.Provider>;
}

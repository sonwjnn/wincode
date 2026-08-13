import type { AgentId } from "@wincode/ai";
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
	type McpSnapshotTool,
} from "../registry";
import type { McpNormalizedResult } from "../result";

/**
 * The generic gate that decides one ask-gated MCP tool call. Given the resolved
 * snapshot tool and its input, it applies the composed Permission decision plus
 * any temporary grant, auto approval, or interactive approval and returns the
 * settled outcome. It lives outside this module (in the chat tool-call handler)
 * so MCP tools share the same approval queue, grant store, and dialog as static
 * coding tools instead of a separate MCP-only controller.
 */
export type McpApprovalDecision =
	| { kind: "allow" }
	| { kind: "deny" }
	| { kind: "reject"; feedback?: string };

export type McpApprovalGate = (
	tool: McpSnapshotTool,
	input: unknown
) => Promise<McpApprovalDecision>;

export type McpDynamicToolCall = {
	dynamic?: boolean;
	input?: unknown;
	toolCallId: string;
	toolName: string;
};

export type McpToolOutputConfig = {
	errorText?: string;
	output?: unknown;
	state: "output-available" | "output-error";
	tool: string;
	toolCallId: string;
};

export type McpAddToolOutput = (
	config: McpToolOutputConfig
) => void | PromiseLike<void>;

export const MCP_NO_ACTIVE_CATALOG_ERROR =
	"MCP tool call has no active catalog";

const MCP_TOOL_CALL_FAILED_ERROR = "MCP tool call failed";

const outputErrorText = (
	addToolOutput: McpAddToolOutput,
	toolCall: McpDynamicToolCall,
	errorText: string
): void | PromiseLike<void> =>
	addToolOutput({
		errorText,
		state: "output-error",
		tool: toolCall.toolName,
		toolCallId: toolCall.toolCallId,
	});

export type RunDynamicToolCallDeps = {
	addToolOutput: McpAddToolOutput;
	gate: McpApprovalGate;
	latestSnapshot: McpCatalogSnapshot | null;
	registry: Pick<McpRegistry, "execute">;
	snapshot: McpCatalogSnapshot | null;
	toolCall: McpDynamicToolCall;
};

/**
 * Resolves one dynamic MCP tool call without blocking the caller. The provider
 * schedules this; it never awaits an AI SDK `onToolCall` synchronously.
 *
 * - Snapshot missing or stale -> stable output-error.
 * - The `gate` applies the composed Permission decision, temporary grants, auto
 *   approval, and (for an ask) the shared approval dialog:
 *   - `deny` -> stable output-error, no execution.
 *   - `reject` -> stable output-error carrying the optional bounded feedback.
 *   - `allow` -> executes through the registry. Every outcome is emitted
 *     through `addToolOutput` with the AI SDK output shape.
 * - Errors that escape the registry are reduced to a stable message so no
 *   secret, header, URL, or command can reach tool output.
 */
export function runDynamicToolCall(
	deps: RunDynamicToolCallDeps
): Promise<void> {
	const { addToolOutput, gate, latestSnapshot, registry, snapshot, toolCall } =
		deps;

	return (async () => {
		if (
			snapshot === null ||
			latestSnapshot === null ||
			snapshot.id !== latestSnapshot.id
		) {
			await outputErrorText(
				addToolOutput,
				toolCall,
				MCP_NO_ACTIVE_CATALOG_ERROR
			);
			return;
		}

		const tool: McpSnapshotTool | undefined = snapshot.tools.get(
			toolCall.toolName
		);
		if (tool === undefined) {
			await outputErrorText(
				addToolOutput,
				toolCall,
				`Unknown MCP tool '${toolCall.toolName}'`
			);
			return;
		}

		let decision: McpApprovalDecision;
		try {
			decision = await gate(tool, toolCall.input);
		} catch {
			await outputErrorText(
				addToolOutput,
				toolCall,
				MCP_TOOL_CALL_FAILED_ERROR
			);
			return;
		}
		if (decision.kind === "deny") {
			await outputErrorText(
				addToolOutput,
				toolCall,
				`MCP tool '${toolCall.toolName}' is denied by policy`
			);
			return;
		}
		if (decision.kind === "reject") {
			await outputErrorText(
				addToolOutput,
				toolCall,
				decision.feedback === undefined
					? `MCP tool '${toolCall.toolName}' was not approved`
					: `MCP tool '${toolCall.toolName}' was not approved — ${decision.feedback}`
			);
			return;
		}

		const approve = (): Promise<boolean> => Promise.resolve(true);
		let result: McpNormalizedResult;
		try {
			result = await registry.execute(
				snapshot,
				toolCall.toolName,
				toolCall.input,
				approve
			);
		} catch {
			await outputErrorText(
				addToolOutput,
				toolCall,
				MCP_TOOL_CALL_FAILED_ERROR
			);
			return;
		}

		if (result.isError) {
			await outputErrorText(
				addToolOutput,
				toolCall,
				MCP_TOOL_CALL_FAILED_ERROR
			);
			return;
		}

		await addToolOutput({
			output: result,
			state: "output-available",
			tool: toolCall.toolName,
			toolCallId: toolCall.toolCallId,
		});
	})();
}

export type McpContextValue = {
	close(): Promise<void>;
	initialize(): Promise<void>;
	createSnapshot(
		agent: AgentId,
		agentPolicy?: McpAgentPolicy
	): Promise<McpCatalogSnapshot>;
	handleDynamicToolCall(
		snapshot: McpCatalogSnapshot | null,
		toolCall: McpDynamicToolCall,
		addToolOutput: McpAddToolOutput,
		gate: McpApprovalGate
	): void;
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
	let failed = 0;
	for (const status of statuses) {
		if (status.state === "failed") {
			failed += 1;
		}
	}
	if (failed === 0) {
		return null;
	}
	return `MCP: ${failed} failed.`;
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
	workspace: string;
};

export function McpProvider({
	children,
	closeRegistryOnUnmount = true,
	createRegistry,
	workspace,
}: McpProviderProps) {
	const toast = useToast();
	const [registry] = useState<McpRegistry>(() =>
		(createRegistry ?? createMcpRegistry)({ workspace })
	);
	// Latest catalog snapshot is tracked in a ref so tool calls resolve against
	// it synchronously, without waiting for a re-render after createSnapshot.
	const latestSnapshotRef = useRef<McpCatalogSnapshot | null>(null);
	const summaryToastShownRef = useRef(false);
	const initializePromiseRef = useRef<Promise<void> | null>(null);
	const initialize = useCallback((): Promise<void> => {
		initializePromiseRef.current ??= registry.initialize();
		return initializePromiseRef.current;
	}, [registry]);

	useEffect(() => {
		void initialize().catch(() => undefined);
		return () => {
			if (closeRegistryOnUnmount) {
				void registry.close();
			}
		};
	}, [closeRegistryOnUnmount, initialize, registry]);

	const createSnapshot = useCallback(
		async (
			agent: AgentId,
			agentPolicy?: McpAgentPolicy
		): Promise<McpCatalogSnapshot> => {
			const snapshot = await registry.createSnapshot(agent, agentPolicy);
			latestSnapshotRef.current = snapshot;
			if (agent === "build" && !summaryToastShownRef.current) {
				const summary = buildMcpSummary(registry.getStatuses());
				if (summary !== null) {
					summaryToastShownRef.current = true;
					toast.show({ message: summary });
				}
			}
			return snapshot;
		},
		[registry, toast.show]
	);

	const handleDynamicToolCall = useCallback(
		(
			snapshot: McpCatalogSnapshot | null,
			toolCall: McpDynamicToolCall,
			addToolOutput: McpAddToolOutput,
			gate: McpApprovalGate
		): void => {
			void runDynamicToolCall({
				addToolOutput,
				gate,
				latestSnapshot: latestSnapshotRef.current,
				registry,
				snapshot,
				toolCall,
			}).catch(() => undefined);
		},
		[registry]
	);

	const statusesCacheRef = useRef<readonly McpServerStatus[] | null>(null);

	// `registry.getStatuses()` builds a fresh array on every call. useSyncExternalStore
	// requires a stable snapshot between notifications, so cache it here and invalidate
	// on every registry emit. This keeps the exact subscribe/getStatuses contract while
	// avoiding render-triggered snapshot churn.
	useEffect(() => {
		const unsubscribe = registry.subscribe(() => {
			statusesCacheRef.current = null;
		});
		return unsubscribe;
	}, [registry]);

	const getStatusesSnapshot = useCallback((): readonly McpServerStatus[] => {
		if (statusesCacheRef.current === null) {
			statusesCacheRef.current = registry.getStatuses();
		}
		return statusesCacheRef.current;
	}, [registry]);

	const statuses = useSyncExternalStore(
		registry.subscribe,
		getStatusesSnapshot,
		getStatusesSnapshot
	);

	const value = useMemo<McpContextValue>(
		() => ({
			close: () => registry.close(),
			createSnapshot,
			handleDynamicToolCall,
			initialize,
			reconnect: (serverName) => registry.reconnect(serverName),
			statuses,
			toggle: (serverName) => registry.toggle(serverName),
		}),
		[createSnapshot, handleDynamicToolCall, initialize, registry, statuses]
	);

	return <McpContext.Provider value={value}>{children}</McpContext.Provider>;
}

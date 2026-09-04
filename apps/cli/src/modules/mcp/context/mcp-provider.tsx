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
import type { GateOutcome } from "@/modules/tool-gate/tool-gate";
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
import type { JsonValue, McpNormalizedResult } from "../result";

/**
 * The generic gate that decides one ask-gated MCP tool call. Given the resolved
 * snapshot tool and its input, it applies the composed Permission decision plus
 * any temporary grant, auto approval, or interactive approval and returns the
 * settled outcome. It lives outside this module (in the chat tool-call handler)
 * so MCP tools share the same approval queue, grant store, and inline approval
 * panel as static coding tools instead of a separate MCP-only controller.
 */
export type McpApprovalDecision = GateOutcome;

export type McpApprovalGate = (
	tool: McpSnapshotTool,
	input: unknown,
	toolCallId: string
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

// Registry-owned guard errors are single sanitized text parts (stale snapshot,
// unknown tool, policy denial, disabled server, execution failure); MCP server
// content is untrusted and must never surface through the error path.
const isRegistryOwnedTextPart = (
	value: JsonValue | undefined
): value is { text: string; type: "text" } =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	value.type === "text" &&
	typeof value.text === "string";

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
 *   approval, and (for an ask) the shared inline approval panel:
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
		// The pre-gate staleness check is deliberate: a catalog refresh must never
		// gate — and therefore never prompt for — a snapshot that is no longer
		// current. The registry repeats the check at execute time as a TOCTOU
		// guard; the two guards protect different moments.
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
			decision = await gate(tool, toolCall.input, toolCall.toolCallId);
		} catch {
			await outputErrorText(
				addToolOutput,
				toolCall,
				MCP_TOOL_CALL_FAILED_ERROR
			);
			return;
		}
		if (decision.kind === "deny") {
			await outputErrorText(addToolOutput, toolCall, decision.errorText);
			return;
		}
		if (decision.kind === "reject") {
			await outputErrorText(addToolOutput, toolCall, decision.errorText);
			return;
		}

		let result: McpNormalizedResult;
		try {
			result = await registry.execute(
				snapshot,
				toolCall.toolName,
				toolCall.input
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
			const firstPart = result.content[0];
			const errorText =
				result.owner === "registry" && isRegistryOwnedTextPart(firstPart)
					? firstPart.text
					: MCP_TOOL_CALL_FAILED_ERROR;
			await outputErrorText(addToolOutput, toolCall, errorText);
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
	// Latest catalog snapshot is tracked in a ref so tool calls resolve against
	// it synchronously, without waiting for a re-render after createSnapshot.
	const latestSnapshotRef = useRef<McpCatalogSnapshot | null>(null);
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
			if (trackLatest) {
				latestSnapshotRef.current = snapshot;
			}
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
			handleDynamicToolCall,
			initialize,
			isLoading,
			reconnect,
			statuses,
			toggle,
		}),
		[
			createSnapshot,
			handleDynamicToolCall,
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

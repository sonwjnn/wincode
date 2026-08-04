import type { ModeType } from "@wincode/ai";
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
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import {
	createMcpRegistry,
	type McpApprovalRequest,
	type McpCatalogSnapshot,
	type McpRegistry,
	type McpRegistryDeps,
	type McpServerStatus,
	type McpSnapshotTool,
} from "../registry";
import type { McpNormalizedResult } from "../result";
import { McpApprovalDialog } from "../ui/mcp-approval-dialog";
import {
	createMcpApprovalController,
	type McpApprovalController,
} from "./approval-controller";

export type { McpApprovalController } from "./approval-controller";
export { createMcpApprovalController } from "./approval-controller";

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

const mcpResultErrorText = (
	result: McpNormalizedResult
): string | undefined => {
	for (const item of result.content) {
		if (
			typeof item === "object" &&
			item !== null &&
			!Array.isArray(item) &&
			item.type === "text" &&
			typeof item.text === "string"
		) {
			return item.text;
		}
	}
};

export type RunDynamicToolCallDeps = {
	addToolOutput: McpAddToolOutput;
	latestSnapshot: McpCatalogSnapshot | null;
	openApproval: (
		request: McpApprovalRequest,
		controller: McpApprovalController
	) => void;
	registry: Pick<McpRegistry, "execute">;
	snapshot: McpCatalogSnapshot | null;
	toolCall: McpDynamicToolCall;
};

/**
 * Resolves one dynamic MCP tool call without blocking the caller. The provider
 * schedules this; it never awaits an AI SDK `onToolCall` synchronously.
 *
 * - Snapshot missing or stale -> stable output-error.
 * - Policy `deny` -> stable output-error, no execution.
 * - Policy `ask` -> opens the approval dialog through `openApproval`; a denied
 *   or cancelled request becomes a stable output-error.
 * - Policy `allow` (or approved) -> executes through the registry. Every
 *   outcome is emitted through `addToolOutput` with the AI SDK output shape.
 * - Errors that escape the registry are reduced to a stable message so no
 *   secret, header, URL, or command can reach tool output.
 */
export function runDynamicToolCall(
	deps: RunDynamicToolCallDeps
): Promise<void> {
	const {
		addToolOutput,
		latestSnapshot,
		openApproval,
		registry,
		snapshot,
		toolCall,
	} = deps;

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

		if (tool.policy === "deny") {
			await outputErrorText(
				addToolOutput,
				toolCall,
				`MCP tool '${toolCall.toolName}' is denied by policy`
			);
			return;
		}

		if (tool.policy === "ask") {
			const request: McpApprovalRequest = {
				description: tool.description,
				input: toolCall.input,
				originalToolName: tool.originalToolName,
				serverName: tool.serverName,
			};
			const controller = createMcpApprovalController();
			openApproval(request, controller);
			const approved = await controller.request(request);
			if (!approved) {
				await outputErrorText(
					addToolOutput,
					toolCall,
					`MCP tool '${toolCall.toolName}' was not approved`
				);
				return;
			}
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
				mcpResultErrorText(result) ?? MCP_TOOL_CALL_FAILED_ERROR
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
	createSnapshot(mode: ModeType): Promise<McpCatalogSnapshot>;
	handleDynamicToolCall(
		snapshot: McpCatalogSnapshot | null,
		toolCall: McpDynamicToolCall,
		addToolOutput: McpAddToolOutput
	): void;
	reconnect(serverName: string): Promise<void>;
	statuses: readonly McpServerStatus[];
};

/**
 * Builds the one-time startup summary for a build catalog. Returns null when
 * nothing meaningful initialized (no connected or failed servers), so callers
 * only surface a toast once the MCP catalog actually resolved.
 */
export function buildMcpSummary(
	statuses: readonly McpServerStatus[]
): string | null {
	let connected = 0;
	let failed = 0;
	for (const status of statuses) {
		if (status.state === "connected") {
			connected += 1;
		} else if (status.state === "failed") {
			failed += 1;
		}
	}
	if (connected === 0 && failed === 0) {
		return null;
	}
	return `MCP: ${connected} connected, ${failed} failed.`;
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
	createRegistry?: (deps: McpRegistryDeps) => McpRegistry;
	workspace: string;
};

export function McpProvider({
	children,
	createRegistry,
	workspace,
}: McpProviderProps) {
	const dialog = useDialog();
	const toast = useToast();
	const [registry] = useState<McpRegistry>(() =>
		(createRegistry ?? createMcpRegistry)({ workspace })
	);
	// Latest catalog snapshot is tracked in a ref so tool calls resolve against
	// it synchronously, without waiting for a re-render after createSnapshot.
	const latestSnapshotRef = useRef<McpCatalogSnapshot | null>(null);
	const summaryToastShownRef = useRef(false);

	useEffect(
		() => () => {
			void registry.close();
		},
		[registry]
	);

	const openApproval = useCallback(
		(request: McpApprovalRequest, controller: McpApprovalController) => {
			dialog.open({
				children: (
					<McpApprovalDialog controller={controller} request={request} />
				),
				title: "MCP tool approval",
				width: 100,
			});
		},
		[dialog]
	);

	const createSnapshot = useCallback(
		async (mode: ModeType): Promise<McpCatalogSnapshot> => {
			const snapshot = await registry.createSnapshot(mode);
			latestSnapshotRef.current = snapshot;
			if (mode === "build" && !summaryToastShownRef.current) {
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
			addToolOutput: McpAddToolOutput
		): void => {
			void runDynamicToolCall({
				addToolOutput,
				latestSnapshot: latestSnapshotRef.current,
				openApproval,
				registry,
				snapshot,
				toolCall,
			});
		},
		[openApproval, registry]
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
			reconnect: (serverName) => registry.reconnect(serverName),
			statuses,
		}),
		[createSnapshot, handleDynamicToolCall, registry, statuses]
	);

	return <McpContext.Provider value={value}>{children}</McpContext.Provider>;
}

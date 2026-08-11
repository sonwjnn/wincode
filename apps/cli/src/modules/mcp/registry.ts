import {
	type AgentId,
	isJsonValue,
	type JsonObject,
	MAX_MCP_TOOL_COUNT,
	type McpToolManifest,
	type McpToolManifestEntry,
} from "@wincode/ai";
import {
	composePermissionDecisions,
	DEFAULT_EFFECTIVE_AGENT_POLICY,
	decideOpenActionPermission,
	type EffectiveAgentPolicy,
} from "@/modules/permissions";
import type { ConfigStore } from "@/shared/config/config-store";
import {
	createSdkMcpClient,
	createSdkMcpClientDeps,
	type McpClient,
	type McpClientFactoryDeps,
	type McpClientTool,
} from "./client";
import {
	DEFAULT_MCP_TIMEOUTS,
	loadMcpConfig,
	type McpConfigInput,
	type McpConfigResult,
	type ResolvedMcpServerConfig,
} from "./config";
import type { McpExecutionPolicy } from "./policy";
import { type McpNormalizedResult, normalizeMcpResult } from "./result";
import { sanitizeMessage } from "./sanitize";
import { logicalMcpToolName, qualifyMcpToolName } from "./tool-identity";

/**
 * The Agent's effective Permission policy as it applies to MCP tools: the folded
 * rules matched against logical tool names and whether the Agent runs under the
 * manual-only safety ceiling. Composed most-restrictively with each server's own
 * execution policy when a snapshot is built. Defaults to an empty, non-safety
 * policy so callers without an Agent see the server policy unchanged.
 */
export type McpAgentPolicy = EffectiveAgentPolicy;

// Every MCP tool gates against the single `*` resource in this version; only the
// logical tool name distinguishes rules. Exported so the chat approval gate keys
// grants against the identical resource the snapshot composed with.
export const MCP_PERMISSION_RESOURCE = "*";

/**
 * Composes an Agent's MCP policy for one logical tool name with the server's
 * independent execution policy, most-restrictively, then applies the Agent's
 * manual-only safety ceiling: under the ceiling every non-deny decision becomes
 * a manual `ask` so remembered grants and auto approval cannot bypass it.
 */
const composeMcpToolDecision = (
	serverPolicy: McpExecutionPolicy,
	agentPolicy: McpAgentPolicy,
	logicalName: string
): McpExecutionPolicy => {
	const agentDecision = decideOpenActionPermission(
		agentPolicy.rules,
		logicalName,
		MCP_PERMISSION_RESOURCE
	);
	const composed = composePermissionDecisions(serverPolicy, agentDecision);
	if (agentPolicy.safety && composed !== "deny") {
		return "ask";
	}
	return composed;
};

export type McpServerState =
	| "disabled"
	| "connecting"
	| "connected"
	| "degraded"
	| "failed";

export type McpServerStatus = {
	error?: string;
	name: string;
	state: McpServerState;
	toolCount: number;
	transport: "local" | "remote";
};

export type McpApprovalRequest = {
	description: string;
	input: unknown;
	originalToolName: string;
	serverName: string;
};

export type McpSnapshotTool = {
	client: McpClient;
	description: string;
	/**
	 * The stable logical Permission action name (`<sanitizedServer>_<sanitizedTool>`)
	 * this tool's decision was evaluated against and that a remembered grant is
	 * keyed by. Distinct from the hashed dispatch identity used as the map key.
	 */
	logicalName: string;
	originalToolName: string;
	/** The composed Agent + server decision after any safety ceiling. */
	policy: McpExecutionPolicy;
	/**
	 * True when the governing Agent policy is a manual-only safety ceiling, so an
	 * `ask` here must never be satisfied by a remembered grant or auto approval.
	 */
	safety: boolean;
	serverName: string;
};

export type McpCatalogSnapshot = {
	agent: AgentId;
	id: string;
	manifest: McpToolManifest;
	tools: ReadonlyMap<string, McpSnapshotTool>;
};

export type McpRegistry = {
	close(): Promise<void>;
	createSnapshot(
		agent: AgentId,
		agentPolicy?: McpAgentPolicy
	): Promise<McpCatalogSnapshot>;
	execute(
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		approve: (request: McpApprovalRequest) => Promise<boolean>,
		signal?: AbortSignal
	): Promise<McpNormalizedResult>;
	getStatuses(): readonly McpServerStatus[];
	reconnect(serverName: string): Promise<void>;
	subscribe(listener: () => void): () => void;
};

export type McpRegistryDeps = {
	configRoot?: string;
	configStore?: ConfigStore;
	createClient?: (config: ResolvedMcpServerConfig) => McpClient;
	env?: Record<string, string | undefined>;
	homeRoot?: string;
	loadConfig?: (input: McpConfigInput) => Promise<McpConfigResult>;
	workspace: string;
};

type ServerEntry = {
	client: McpClient | undefined;
	config: ResolvedMcpServerConfig;
	error: string | undefined;
	state: McpServerState;
	tools: readonly McpClientTool[];
};

const outputError = (message: string): McpNormalizedResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
	truncated: false,
});

const toJsonObject = (value: Record<string, unknown>): JsonObject => {
	if (
		isJsonValue(value) &&
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value)
	) {
		return value;
	}
	return { type: "object" };
};

const defaultSdkClientFactory = (
	workspace: string,
	env: Record<string, string | undefined>
): ((config: ResolvedMcpServerConfig) => McpClient) => {
	let deps: McpClientFactoryDeps | undefined;
	return (config) => {
		if (deps === undefined) {
			const environment = Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined
				)
			);
			deps = createSdkMcpClientDeps({
				clientInfo: { name: "wincode-cli", version: "0.1.0" },
				environment,
				workspace,
			});
		}
		return createSdkMcpClient(config, deps);
	};
};

export function createMcpRegistry(input: McpRegistryDeps): McpRegistry {
	const workspace = input.workspace;
	const env = input.env ?? { ...process.env };
	const loadConfig = input.loadConfig ?? loadMcpConfig;
	const createClient =
		input.createClient ?? defaultSdkClientFactory(workspace, env);

	const serverEntries = new Map<string, ServerEntry>();
	const listeners = new Set<() => void>();
	const closeController = new AbortController();
	let closed = false;
	let initPromise: Promise<void> | undefined;
	const reconnects = new Map<string, Promise<void>>();
	let latestSnapshotId: string | undefined;

	const emit = (): void => {
		for (const listener of [...listeners]) {
			listener();
		}
	};

	const closeClient = async (entry: ServerEntry): Promise<void> => {
		const client = entry.client;
		if (client === undefined) {
			return;
		}
		entry.client = undefined;
		try {
			await client.close();
		} catch {
			// closing is best-effort; errors are sanitized upstream
		}
	};

	const startupSignal = (entry: ServerEntry): AbortSignal =>
		AbortSignal.any([
			AbortSignal.timeout(entry.config.timeout.startup),
			closeController.signal,
		]);

	const catalogSignal = (entry: ServerEntry): AbortSignal =>
		AbortSignal.any([
			AbortSignal.timeout(entry.config.timeout.catalog),
			closeController.signal,
		]);

	const connectEntry = async (entry: ServerEntry): Promise<void> => {
		const client = entry.client ?? createClient(entry.config);
		entry.client = client;
		client.setToolsChangedListener((tools) => {
			entry.tools = tools;
		});
		entry.state = "connecting";
		entry.error = undefined;
		try {
			await client.connect(startupSignal(entry));
			entry.tools = await client.listTools(catalogSignal(entry));
			entry.state = "connected";
			entry.error = undefined;
		} catch (error) {
			entry.state = "failed";
			entry.error = sanitizeMessage(
				entry.config,
				error,
				"unknown MCP registry error"
			);
			await closeClient(entry);
		}
	};

	const doInit = async (): Promise<void> => {
		const configResult = await loadConfig({
			env,
			workspace,
			...(input.configRoot ? { configRoot: input.configRoot } : {}),
			...(input.configStore ? { configStore: input.configStore } : {}),
			...(input.homeRoot ? { homeRoot: input.homeRoot } : {}),
		});
		for (const [name, config] of Object.entries(configResult.servers)) {
			serverEntries.set(name, {
				client: undefined,
				config,
				error: undefined,
				state: config.disabled ? "disabled" : "connecting",
				tools: [],
			});
		}
		const connects: Promise<void>[] = [];
		for (const entry of serverEntries.values()) {
			if (entry.state !== "disabled") {
				connects.push(connectEntry(entry));
			}
		}
		await Promise.allSettled(connects);
		emit();
	};

	const init = (): Promise<void> => {
		if (initPromise === undefined) {
			initPromise = doInit();
		}
		return initPromise;
	};

	const buildSnapshot = async (
		agent: AgentId,
		agentPolicy: McpAgentPolicy
	): Promise<McpCatalogSnapshot> => {
		type Candidate = {
			client: McpClient;
			config: ResolvedMcpServerConfig;
			serverPolicy: McpExecutionPolicy;
			tool: McpClientTool;
		};
		const candidates: Candidate[] = [];
		for (const entry of serverEntries.values()) {
			if (entry.client === undefined) {
				continue;
			}
			const serverPolicy = entry.config.permission;
			for (const tool of entry.tools) {
				candidates.push({
					client: entry.client,
					config: entry.config,
					serverPolicy,
					tool,
				});
			}
		}
		candidates.sort((a, b) => {
			const byServer = a.config.name.localeCompare(b.config.name);
			if (byServer !== 0) {
				return byServer;
			}
			return a.tool.name.localeCompare(b.tool.name);
		});
		const manifest: McpToolManifestEntry[] = [];
		const tools = new Map<string, McpSnapshotTool>();
		let visibleCount = 0;
		for (const candidate of candidates) {
			const name = await qualifyMcpToolName(
				candidate.config.name,
				candidate.tool.name
			);
			const logicalName = logicalMcpToolName(
				candidate.config.name,
				candidate.tool.name
			);
			const policy = composeMcpToolDecision(
				candidate.serverPolicy,
				agentPolicy,
				logicalName
			);
			const description = candidate.tool.description ?? "";
			tools.set(name, {
				client: candidate.client,
				description,
				logicalName,
				originalToolName: candidate.tool.name,
				policy,
				safety: agentPolicy.safety,
				serverName: candidate.config.name,
			});
			if (policy !== "deny" && visibleCount < MAX_MCP_TOOL_COUNT) {
				manifest.push({
					name,
					description,
					inputSchema: toJsonObject(candidate.tool.inputSchema),
				});
				visibleCount += 1;
			}
		}
		return {
			agent,
			id: crypto.randomUUID(),
			manifest,
			tools,
		};
	};

	const createSnapshot = async (
		agent: AgentId,
		agentPolicy: McpAgentPolicy = DEFAULT_EFFECTIVE_AGENT_POLICY
	): Promise<McpCatalogSnapshot> => {
		if (closed) {
			const snapshot: McpCatalogSnapshot = {
				agent,
				id: crypto.randomUUID(),
				manifest: [],
				tools: new Map(),
			};
			latestSnapshotId = snapshot.id;
			return snapshot;
		}
		await init();
		const snapshot = await buildSnapshot(agent, agentPolicy);
		latestSnapshotId = snapshot.id;
		return snapshot;
	};

	const executionError = (
		toolName: string,
		timeout: AbortSignal,
		callerSignal: AbortSignal | undefined,
		config: ResolvedMcpServerConfig | undefined,
		error: unknown
	): string => {
		if (callerSignal?.aborted) {
			return `MCP tool '${toolName}' was cancelled`;
		}
		if (timeout.aborted) {
			return `MCP tool '${toolName}' timed out`;
		}
		if (closeController.signal.aborted) {
			return "MCP registry is closing";
		}
		return sanitizeMessage(config, error, "unknown MCP registry error");
	};

	const gateApproval = async (
		tool: McpSnapshotTool,
		toolName: string,
		input: unknown,
		approve: (request: McpApprovalRequest) => Promise<boolean>
	): Promise<McpNormalizedResult | undefined> => {
		if (tool.policy === "deny") {
			return outputError(`MCP tool '${toolName}' is denied by policy`);
		}
		if (tool.policy === "ask") {
			let approved = false;
			try {
				approved = await approve({
					description: tool.description,
					input,
					originalToolName: tool.originalToolName,
					serverName: tool.serverName,
				});
			} catch {
				approved = false;
			}
			if (!approved) {
				return outputError(`MCP tool '${toolName}' was not approved`);
			}
		}
		return;
	};

	const execute = async (
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		approve: (request: McpApprovalRequest) => Promise<boolean>,
		signal?: AbortSignal
	): Promise<McpNormalizedResult> => {
		if (snapshot.id !== latestSnapshotId) {
			return outputError("MCP tool snapshot is stale or not executable");
		}
		const tool = snapshot.tools.get(toolName);
		if (tool === undefined) {
			return outputError(`Unknown MCP tool '${toolName}'`);
		}
		const blocked = await gateApproval(tool, toolName, input, approve);
		if (blocked !== undefined) {
			return blocked;
		}
		const entry = serverEntries.get(tool.serverName);
		const timeout = AbortSignal.timeout(
			entry?.config.timeout.execution ?? DEFAULT_MCP_TIMEOUTS.execution
		);
		const signals: AbortSignal[] = [timeout, closeController.signal];
		if (signal !== undefined) {
			signals.push(signal);
		}
		const combined = AbortSignal.any(signals);
		const callerAborted = signal?.aborted === true;
		try {
			const raw = await tool.client.callTool(
				tool.originalToolName,
				input,
				combined
			);
			return normalizeMcpResult(raw);
		} catch (error) {
			const message = executionError(
				toolName,
				timeout,
				signal,
				entry?.config,
				error
			);
			if (
				!(callerAborted || closeController.signal.aborted) &&
				entry !== undefined
			) {
				await closeClient(entry);
				entry.state = "degraded";
				entry.error = message;
				emit();
			}
			return outputError(message);
		}
	};

	const doReconnect = async (entry: ServerEntry): Promise<void> => {
		await closeClient(entry);
		entry.client = createClient(entry.config);
		entry.client.setToolsChangedListener((tools) => {
			entry.tools = tools;
		});
		entry.state = "connecting";
		entry.error = undefined;
		try {
			await entry.client.connect(startupSignal(entry));
			entry.tools = await entry.client.listTools(catalogSignal(entry));
			entry.state = "connected";
			entry.error = undefined;
		} catch (error) {
			entry.state = "failed";
			entry.error = sanitizeMessage(
				entry.config,
				error,
				"unknown MCP registry error"
			);
			await closeClient(entry);
		}
		emit();
	};

	const reconnect = (serverName: string): Promise<void> => {
		const entry = serverEntries.get(serverName);
		if (entry === undefined) {
			return Promise.resolve();
		}
		if (entry.config.disabled || entry.state === "disabled") {
			return Promise.resolve();
		}
		const inFlight = reconnects.get(serverName);
		if (inFlight !== undefined) {
			return inFlight;
		}
		if (entry.state === "connecting") {
			return Promise.resolve();
		}
		const run = doReconnect(entry);
		reconnects.set(serverName, run);
		run.then(
			() => {
				reconnects.delete(serverName);
			},
			() => {
				reconnects.delete(serverName);
			}
		);
		return run;
	};

	const getStatuses = (): readonly McpServerStatus[] =>
		[...serverEntries.values()].map((entry) => ({
			error: entry.error,
			name: entry.config.name,
			state: entry.state,
			toolCount: entry.tools.length,
			transport: entry.config.type,
		}));

	const subscribe = (listener: () => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	const close = async (): Promise<void> => {
		if (closed) {
			return;
		}
		closed = true;
		closeController.abort();
		if (initPromise !== undefined) {
			try {
				await initPromise;
			} catch {
				// init is best-effort; individual connect failures are already surfaced
			}
		}
		await Promise.allSettled([...serverEntries.values()].map(closeClient));
		listeners.clear();
	};

	return {
		close,
		createSnapshot,
		execute,
		getStatuses,
		reconnect,
		subscribe,
	};
}

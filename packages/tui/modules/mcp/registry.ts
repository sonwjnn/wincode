import { isDeepStrictEqual } from "node:util";
import type { AgentId } from "@wincode/agent-core";
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
	loadMcpConfig,
	type McpConfigInput,
	type McpConfigResult,
	type ResolvedMcpServerConfig,
} from "./config";
import {
	isJsonValue,
	type JsonObject,
	MAX_MCP_TOOL_COUNT,
	type McpToolManifest,
	type McpToolManifestEntry,
} from "./manifest";
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
 * The single denial wording for MCP tools, owned here so the gate and the
 * registry guard can never drift. The registry emits it for a denied dispatch
 * entry and the Tool Gate emits it for a composed policy deny.
 */
export const mcpDeniedByPolicyText = (toolName: string): string =>
	`MCP tool '${toolName}' is denied by policy`;

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

export type McpSnapshotTool = {
	agentDecision: McpExecutionPolicy;
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
	serverDecision: McpExecutionPolicy;
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
	initialize(): Promise<void>;
	createSnapshot(
		agent: AgentId,
		agentPolicy?: McpAgentPolicy,
		trackLatest?: boolean
	): Promise<McpCatalogSnapshot>;
	execute(
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<McpNormalizedResult>;
	releaseSnapshot?(snapshot: McpCatalogSnapshot): void;
	getStatuses(): readonly McpServerStatus[];
	reconnect(serverName: string): Promise<void>;
	subscribe(listener: () => void): () => void;
	toggle(serverName: string): Promise<void>;
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
	executionController: AbortController;
	state: McpServerState;
	tools: readonly McpClientTool[];
};

const outputError = (message: string): McpNormalizedResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
	owner: "registry",
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

const requestedRemoteTools = (
	config: ResolvedMcpServerConfig
): readonly string[] => {
	if (config.type !== "remote") {
		return [];
	}
	const requested = new Set<string>();
	for (const value of new URL(config.url).searchParams.getAll("tools")) {
		for (const name of value.split(",")) {
			const trimmed = name.trim();
			if (trimmed.length > 0) {
				requested.add(trimmed);
			}
		}
	}
	return [...requested];
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
	const invalidStatuses = new Map<string, McpServerStatus>();
	const listeners = new Set<() => void>();
	const closeController = new AbortController();
	let closed = false;
	let initPromise: Promise<void> | undefined;
	let initialized = false;
	let refreshPromise: Promise<void> | undefined;
	const entryOperations = new Map<string, Promise<void>>();
	const reconnects = new Map<string, Promise<void>>();
	const toggles = new Map<string, Promise<void>>();
	let latestSnapshotId: string | undefined;
	const activeSnapshotIds = new Set<string>();
	const untrackedSnapshotIds = new Set<string>();
	let catalogGeneration = 0;

	const emit = (): void => {
		for (const listener of [...listeners]) {
			listener();
		}
	};

	const runEntryOperation = (
		serverName: string,
		operation: () => Promise<void>
	): Promise<void> => {
		const previous = entryOperations.get(serverName) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(operation);
		entryOperations.set(serverName, run);
		run.then(
			() => {
				if (entryOperations.get(serverName) === run) {
					entryOperations.delete(serverName);
				}
			},
			() => {
				if (entryOperations.get(serverName) === run) {
					entryOperations.delete(serverName);
				}
			}
		);
		return run;
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

	const listEntryTools = async (
		entry: ServerEntry,
		client: McpClient
	): Promise<readonly McpClientTool[]> => {
		const tools = await client.listTools(catalogSignal(entry));
		const available = new Set(tools.map((tool) => tool.name));
		const hasMissingRequestedTool = requestedRemoteTools(entry.config).some(
			(name) => !available.has(name)
		);
		if (hasMissingRequestedTool) {
			throw new Error("MCP server did not expose all requested tools");
		}
		return tools;
	};

	const loadCurrentConfig = (refresh = false): Promise<McpConfigResult> =>
		loadConfig({
			env,
			refresh,
			workspace,
			...(input.configRoot ? { configRoot: input.configRoot } : {}),
			...(input.configStore ? { configStore: input.configStore } : {}),
			...(input.homeRoot ? { homeRoot: input.homeRoot } : {}),
		});

	const refreshEntryConfig = async (
		entry: ServerEntry,
		serverName: string
	): Promise<boolean> => {
		const configResult = await loadCurrentConfig(true);
		const config = configResult.servers[serverName];
		if (config !== undefined) {
			entry.config = config;
			return true;
		}

		const diagnostic = configResult.diagnostics.find(
			(item) => item.serverName === serverName
		);
		catalogGeneration += 1;
		activeSnapshotIds.clear();
		untrackedSnapshotIds.clear();
		entry.executionController.abort();
		entry.executionController = new AbortController();
		await closeClient(entry);
		entry.error = sanitizeMessage(
			entry.config,
			diagnostic?.message ?? "MCP server configuration is missing or invalid",
			"Invalid MCP server configuration"
		);
		entry.state = "failed";
		entry.tools = [];
		emit();
		return false;
	};

	const connectEntry = async (entry: ServerEntry): Promise<void> => {
		const client = entry.client ?? createClient(entry.config);
		entry.client = client;
		client.setToolsChangedListener((tools) => {
			if (entry.client === client) {
				entry.tools = tools;
			}
		});
		entry.state = "connecting";
		entry.error = undefined;
		try {
			await client.connect(startupSignal(entry));
			entry.tools = await listEntryTools(entry, client);
			entry.state = "connected";
			entry.error = undefined;
		} catch (error) {
			entry.state = "failed";
			entry.tools = [];
			entry.error = sanitizeMessage(
				entry.config,
				error,
				"unknown MCP registry error"
			);
			await closeClient(entry);
		}
	};

	const doInit = async (): Promise<void> => {
		const configResult = await loadCurrentConfig();
		for (const [name, config] of Object.entries(configResult.servers)) {
			serverEntries.set(name, {
				client: undefined,
				config,
				error: undefined,
				executionController: new AbortController(),
				state: config.disabled ? "disabled" : "connecting",
				tools: [],
			});
		}
		for (const invalid of Object.values(configResult.invalidServers ?? {})) {
			if (serverEntries.has(invalid.name)) {
				continue;
			}
			invalidStatuses.set(invalid.name, {
				error: "Invalid MCP server configuration",
				name: invalid.name,
				state: "failed",
				toolCount: 0,
				transport: invalid.transport,
			});
		}
		emit();
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
			initPromise = doInit().then(() => {
				initialized = true;
			});
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
			if (entry.client === undefined || entry.state !== "connected") {
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
			const agentDecision = decideOpenActionPermission(
				agentPolicy.rules,
				logicalName,
				MCP_PERMISSION_RESOURCE
			);
			tools.set(name, {
				agentDecision,
				client: candidate.client,
				description,
				logicalName,
				originalToolName: candidate.tool.name,
				policy,
				safety: agentPolicy.safety,
				serverDecision: candidate.serverPolicy,
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

	const retainSnapshot = (
		snapshot: McpCatalogSnapshot,
		trackLatest: boolean
	): void => {
		activeSnapshotIds.add(snapshot.id);
		if (!trackLatest) {
			untrackedSnapshotIds.add(snapshot.id);
			return;
		}
		if (latestSnapshotId !== undefined) {
			activeSnapshotIds.delete(latestSnapshotId);
		}
		latestSnapshotId = snapshot.id;
	};

	const releaseSnapshot = (snapshot: McpCatalogSnapshot): void => {
		if (snapshot.id === latestSnapshotId) {
			return;
		}
		activeSnapshotIds.delete(snapshot.id);
		untrackedSnapshotIds.delete(snapshot.id);
	};

	const createSnapshot = async (
		agent: AgentId,
		agentPolicy: McpAgentPolicy = DEFAULT_EFFECTIVE_AGENT_POLICY,
		trackLatest = true
	): Promise<McpCatalogSnapshot> => {
		if (closed) {
			const snapshot: McpCatalogSnapshot = {
				agent,
				id: crypto.randomUUID(),
				manifest: [],
				tools: new Map(),
			};
			retainSnapshot(snapshot, trackLatest);
			return snapshot;
		}
		await init();
		while (!closed) {
			const generation = catalogGeneration;
			const snapshot = await buildSnapshot(agent, agentPolicy);
			if (generation === catalogGeneration) {
				retainSnapshot(snapshot, trackLatest);
				return snapshot;
			}
		}
		return {
			agent,
			id: crypto.randomUUID(),
			manifest: [],
			tools: new Map(),
		};
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

	const execute = async (
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<McpNormalizedResult> => {
		// TOCTOU guard, not duplicate validation: between the provider's pre-gate
		// staleness check and this execute, an approval may have been pending while
		// the catalog refreshed (reconnect, toggle, policy change). The gate may
		if (
			!activeSnapshotIds.has(snapshot.id) ||
			(snapshot.id !== latestSnapshotId &&
				!untrackedSnapshotIds.has(snapshot.id))
		) {
			return outputError("MCP tool snapshot is stale or not executable");
		}
		const tool = snapshot.tools.get(toolName);
		if (tool === undefined) {
			return outputError(`Unknown MCP tool '${toolName}'`);
		}
		if (tool.policy === "deny") {
			return outputError(mcpDeniedByPolicyText(toolName));
		}
		const entry = serverEntries.get(tool.serverName);
		if (
			entry === undefined ||
			entry.state !== "connected" ||
			entry.client !== tool.client
		) {
			return outputError(`MCP server '${tool.serverName}' is not enabled`);
		}
		const timeout = AbortSignal.timeout(entry.config.timeout.execution);
		const signals: AbortSignal[] = [
			timeout,
			closeController.signal,
			entry.executionController.signal,
		];
		if (signal !== undefined) {
			signals.push(signal);
		}
		const combined = AbortSignal.any(signals);
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
				signal?.aborted !== true &&
				!closeController.signal.aborted &&
				entry.client === tool.client &&
				!entry.executionController.signal.aborted
			) {
				await closeClient(entry);
				entry.state = "degraded";
				entry.tools = [];
				entry.error = message;
				emit();
			}
			return outputError(message);
		}
	};

	const doReconnect = async (entry: ServerEntry): Promise<void> => {
		catalogGeneration += 1;
		activeSnapshotIds.clear();
		untrackedSnapshotIds.clear();
		entry.executionController.abort();
		entry.executionController = new AbortController();
		await closeClient(entry);
		const client = createClient(entry.config);
		entry.client = client;
		client.setToolsChangedListener((tools) => {
			if (entry.client === client) {
				entry.tools = tools;
			}
		});
		entry.state = "connecting";
		entry.error = undefined;
		try {
			await entry.client.connect(startupSignal(entry));
			entry.tools = await listEntryTools(entry, entry.client);
			entry.state = "connected";
			entry.error = undefined;
		} catch (error) {
			entry.state = "failed";
			entry.tools = [];
			entry.error = sanitizeMessage(
				entry.config,
				error,
				"unknown MCP registry error"
			);
			await closeClient(entry);
		}
		catalogGeneration += 1;
		activeSnapshotIds.clear();
		untrackedSnapshotIds.clear();
		emit();
	};

	const deactivateEntry = async (
		entry: ServerEntry,
		state: "disabled" | "failed",
		error?: string
	): Promise<void> => {
		catalogGeneration += 1;
		activeSnapshotIds.clear();
		untrackedSnapshotIds.clear();
		entry.executionController.abort();
		entry.executionController = new AbortController();
		await closeClient(entry);
		entry.error = error;
		entry.state = state;
		entry.tools = [];
	};

	const refreshExistingEntry = async (
		entry: ServerEntry,
		configResult: McpConfigResult
	): Promise<boolean> => {
		const config = configResult.servers[entry.config.name];
		if (config === undefined) {
			await deactivateEntry(
				entry,
				"failed",
				"Invalid MCP server configuration"
			);
			return false;
		}
		const configChanged = !isDeepStrictEqual(entry.config, config);
		entry.config = config;
		if (config.disabled) {
			if (entry.state !== "disabled") {
				await deactivateEntry(entry, "disabled");
			}
			return false;
		}
		return (
			entry.state !== "disabled" &&
			(configChanged || entry.state === "failed" || entry.state === "degraded")
		);
	};

	const addNewResolvedEntries = (
		configResult: McpConfigResult,
		reconnectEntries: ServerEntry[]
	): void => {
		for (const [name, config] of Object.entries(configResult.servers)) {
			if (serverEntries.has(name)) {
				continue;
			}
			invalidStatuses.delete(name);
			const entry: ServerEntry = {
				client: undefined,
				config,
				error: undefined,
				executionController: new AbortController(),
				state: config.disabled ? "disabled" : "connecting",
				tools: [],
			};
			serverEntries.set(name, entry);
			if (!config.disabled) {
				reconnectEntries.push(entry);
			}
		}
	};

	const syncInvalidStatuses = (configResult: McpConfigResult): void => {
		for (const invalid of Object.values(configResult.invalidServers ?? {})) {
			if (serverEntries.has(invalid.name)) {
				continue;
			}
			invalidStatuses.set(invalid.name, {
				error: "Invalid MCP server configuration",
				name: invalid.name,
				state: "failed",
				toolCount: 0,
				transport: invalid.transport,
			});
		}
	};

	const doRefresh = async (): Promise<void> => {
		const configResult = await loadCurrentConfig(true);
		const reconnectEntries: ServerEntry[] = [];
		const operations: Promise<void>[] = [];
		for (const entry of serverEntries.values()) {
			operations.push(
				runEntryOperation(entry.config.name, async () => {
					if (await refreshExistingEntry(entry, configResult)) {
						await doReconnect(entry);
					}
				})
			);
		}
		addNewResolvedEntries(configResult, reconnectEntries);
		for (const entry of reconnectEntries) {
			operations.push(
				runEntryOperation(entry.config.name, () => doReconnect(entry))
			);
		}
		syncInvalidStatuses(configResult);
		await Promise.allSettled(operations);
		emit();
	};

	const initialize = (): Promise<void> => {
		if (!initialized) {
			return init();
		}
		if (refreshPromise !== undefined) {
			return refreshPromise;
		}
		const refresh = doRefresh();
		refreshPromise = refresh;
		refresh.then(
			() => {
				refreshPromise = undefined;
			},
			() => {
				refreshPromise = undefined;
			}
		);
		return refresh;
	};

	const reconnect = (serverName: string): Promise<void> => {
		const inFlight = reconnects.get(serverName);
		if (inFlight !== undefined) {
			return inFlight;
		}
		const run = runEntryOperation(serverName, async () => {
			await init();
			let entry = serverEntries.get(serverName);
			if (entry === undefined && invalidStatuses.has(serverName)) {
				const config = (await loadCurrentConfig(true)).servers[serverName];
				if (config === undefined) {
					emit();
					return;
				}
				if (serverEntries.has(serverName)) {
					return;
				}
				entry = {
					client: undefined,
					config,
					error: undefined,
					executionController: new AbortController(),
					state: "connecting",
					tools: [],
				};
				invalidStatuses.delete(serverName);
				serverEntries.set(serverName, entry);
				await connectEntry(entry);
				emit();
				return;
			}
			if (
				entry === undefined ||
				entry.state === "disabled" ||
				entry.state === "connecting"
			) {
				return;
			}
			if (!(await refreshEntryConfig(entry, serverName))) {
				return;
			}
			await doReconnect(entry);
		});
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

	const toggle = (serverName: string): Promise<void> => {
		const inFlight = toggles.get(serverName);
		if (inFlight !== undefined) {
			return inFlight;
		}
		const run = runEntryOperation(serverName, async () => {
			await init();
			const entry = serverEntries.get(serverName);
			if (entry === undefined) {
				return;
			}
			if (entry.state === "disabled") {
				if (!(await refreshEntryConfig(entry, serverName))) {
					return;
				}
				await doReconnect(entry);
				return;
			}
			catalogGeneration += 1;
			activeSnapshotIds.clear();
			untrackedSnapshotIds.clear();
			entry.executionController.abort();
			await closeClient(entry);
			entry.error = undefined;
			entry.state = "disabled";
			entry.tools = [];
			emit();
		});
		toggles.set(serverName, run);
		run.then(
			() => toggles.delete(serverName),
			() => toggles.delete(serverName)
		);
		return run;
	};

	const getStatuses = (): readonly McpServerStatus[] => [
		...[...serverEntries.values()].map((entry) => ({
			error: entry.error,
			name: entry.config.name,
			state: entry.state,
			toolCount: entry.tools.length,
			transport: entry.config.type,
		})),
		...invalidStatuses.values(),
	];

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
		releaseSnapshot,
		getStatuses,
		initialize,
		reconnect,
		subscribe,
		toggle,
	};
}

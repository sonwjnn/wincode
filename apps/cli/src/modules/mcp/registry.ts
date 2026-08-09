import {
	isJsonValue,
	type JsonObject,
	MAX_MCP_TOOL_COUNT,
	type McpToolManifest,
	type McpToolManifestEntry,
	type ModeType,
} from "@wincode/ai";
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
import { qualifyMcpToolName } from "./tool-identity";

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
	originalToolName: string;
	policy: McpExecutionPolicy;
	serverName: string;
};

export type McpCatalogSnapshot = {
	id: string;
	manifest: McpToolManifest;
	mode: ModeType;
	tools: ReadonlyMap<string, McpSnapshotTool>;
};

export type McpRegistry = {
	close(): Promise<void>;
	createSnapshot(mode: ModeType): Promise<McpCatalogSnapshot>;
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

	const buildSnapshot = async (): Promise<McpCatalogSnapshot> => {
		type Candidate = {
			client: McpClient;
			config: ResolvedMcpServerConfig;
			policy: McpExecutionPolicy;
			tool: McpClientTool;
		};
		const candidates: Candidate[] = [];
		for (const entry of serverEntries.values()) {
			if (entry.client === undefined) {
				continue;
			}
			const decision = entry.config.permission;
			for (const tool of entry.tools) {
				candidates.push({
					client: entry.client,
					config: entry.config,
					policy: decision,
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
			const description = candidate.tool.description ?? "";
			tools.set(name, {
				client: candidate.client,
				description,
				originalToolName: candidate.tool.name,
				policy: candidate.policy,
				serverName: candidate.config.name,
			});
			if (candidate.policy !== "deny" && visibleCount < MAX_MCP_TOOL_COUNT) {
				manifest.push({
					name,
					description,
					inputSchema: toJsonObject(candidate.tool.inputSchema),
				});
				visibleCount += 1;
			}
		}
		return {
			id: crypto.randomUUID(),
			manifest,
			mode: "build",
			tools,
		};
	};

	const createSnapshot = async (
		mode: ModeType
	): Promise<McpCatalogSnapshot> => {
		if (mode === "plan" || closed) {
			const snapshot: McpCatalogSnapshot = {
				id: crypto.randomUUID(),
				manifest: [],
				mode,
				tools: new Map(),
			};
			latestSnapshotId = snapshot.id;
			return snapshot;
		}
		await init();
		const snapshot = await buildSnapshot();
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
		if (snapshot.id !== latestSnapshotId || snapshot.mode !== "build") {
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

import type { AgentId } from "@wincode/agent-core";
import { isUndefined, omitUndefined } from "@wincode/utils";
import type { JsonObject } from "type-fest";
import {
	createSdkMcpClient,
	createSdkMcpClientDeps,
	type McpClient,
	type McpClientFactoryDeps,
	type McpClientResourceContent,
	type McpClientTool,
} from "./client";
import type {
	McpConfigLoader,
	McpConfigOrigin,
	McpConfigResult,
	ResolvedMcpServerConfig,
} from "./config";
import { type McpSnapshotId, toMcpSnapshotId } from "./identifiers";
import {
	isJsonObject,
	MAX_MCP_TOOL_COUNT,
	type McpToolManifest,
	type McpToolManifestEntry,
} from "./manifest";
import {
	type McpNormalizedResult,
	normalizeMcpResultWithArtifacts,
} from "./result";
import { sanitizeMessage } from "./sanitize";
import { qualifyMcpToolName } from "./tool-identity";

export type McpServerState =
	| "disabled"
	| "connecting"
	| "connected"
	| "degraded"
	| "failed";

export type McpServerStatus = {
	auth: "none" | "required" | "authenticated";
	error?: string;
	exposure: "direct" | "hidden";
	name: string;
	source?: McpConfigOrigin;
	state: McpServerState;
	toolCount: number;
	transport: "local" | "remote";
};

export type McpSnapshotTool = {
	client: McpClient;
	description: string;
	originalToolName: string;
	serverName: string;
};

export type McpResourceSummary = Readonly<{
	description?: string;
	mimeType?: string;
	name: string;
	server: string;
	uri: string;
}>;

export type McpResourceTemplateSummary = Readonly<{
	description?: string;
	mimeType?: string;
	name: string;
	server: string;
	uriTemplate: string;
}>;

export type McpResourcePage = Readonly<{
	errors?: readonly Readonly<{ message: string; server: string }>[];
	nextCursor?: string;
	nextCursorByServer?: Readonly<Record<string, string>>;
	resources: readonly McpResourceSummary[];
}>;

export type McpResourceTemplatePage = Readonly<{
	errors?: readonly Readonly<{ message: string; server: string }>[];
	nextCursor?: string;
	nextCursorByServer?: Readonly<Record<string, string>>;
	resourceTemplates: readonly McpResourceTemplateSummary[];
}>;

export type McpResourceRead = Readonly<{
	contents: readonly McpClientResourceContent[];
	server: string;
}>;

export type McpCatalogSnapshot = {
	agent: AgentId;
	id: McpSnapshotId;
	manifest: McpToolManifest;
	tools: ReadonlyMap<string, McpSnapshotTool>;
};

export type McpOAuthRedirectReader = (callback: Promise<URL>) => Promise<URL>;

export type McpRegistry = {
	close(): Promise<void>;
	initialize(waitForConnections?: boolean): Promise<void>;
	createSnapshot(
		agent: AgentId,
		trackLatest?: boolean
	): Promise<McpCatalogSnapshot>;
	execute(
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<McpNormalizedResult>;
	listResources(
		serverName?: string,
		cursor?: string,
		signal?: AbortSignal
	): Promise<McpResourcePage>;
	listResourceTemplates(
		serverName?: string,
		cursor?: string,
		signal?: AbortSignal
	): Promise<McpResourceTemplatePage>;
	readResource(
		serverName: string,
		uri: string,
		signal?: AbortSignal
	): Promise<McpResourceRead>;
	releaseSnapshot?(snapshot: McpCatalogSnapshot): void;
	getStatuses(): readonly McpServerStatus[];
	login(
		serverName: string,
		readRedirectUrl?: McpOAuthRedirectReader
	): Promise<void>;
	logout(serverName: string): Promise<void>;
	reconnect(serverName: string): Promise<void>;
	subscribe(listener: () => void): () => void;
	toggle(serverName: string): Promise<void>;
};

export type McpRegistryDeps = Readonly<{
	createClient?: (config: ResolvedMcpServerConfig) => McpClient;
	createOAuthProvider?: McpClientFactoryDeps["createOAuthProvider"];
	env?: Readonly<Record<string, string | undefined>>;
	loadConfig: McpConfigLoader;
	loginOAuth?: (
		config: Extract<ResolvedMcpServerConfig, { type: "remote" }>,
		readRedirectUrl?: McpOAuthRedirectReader
	) => Promise<void>;
	logoutOAuth?: (
		config: Extract<ResolvedMcpServerConfig, { type: "remote" }>
	) => Promise<void>;
	workspace: string;
}>;

type McpPageResult<Page> =
	| Readonly<{ entry: ServerEntry; error: string }>
	| Readonly<{ entry: ServerEntry; page: Page }>;

type ServerEntry = {
	client: McpClient | undefined;
	config: ResolvedMcpServerConfig;
	source: McpConfigOrigin | undefined;
	error: string | undefined;
	executionController: AbortController;
	state: McpServerState;
	tools: readonly McpClientTool[];
};

type McpPageCollection<Item> = Readonly<{
	errors: readonly Readonly<{ message: string; server: string }>[] | undefined;
	items: readonly Item[];
	nextCursor: string | undefined;
	nextCursorByServer: Readonly<Record<string, string>> | undefined;
}>;

const collectResourcePages = <Page, SourceItem, Item>(
	pages: readonly McpPageResult<Page>[],
	serverName: string | undefined,
	pageData: (page: Page) => Readonly<{
		items: readonly SourceItem[];
		nextCursor: string | undefined;
	}>,
	summarize: (entry: ServerEntry, item: SourceItem) => Item
): McpPageCollection<Item> => {
	const items: Item[] = [];
	const errors: { message: string; server: string }[] = [];
	const nextCursorByServer: Record<string, string> = {};
	let nextCursor: string | undefined;
	for (const result of pages) {
		if ("error" in result) {
			errors.push({ server: result.entry.config.name, message: result.error });
			continue;
		}
		const data = pageData(result.page);
		for (const item of data.items) {
			items.push(summarize(result.entry, item));
		}
		if (data.nextCursor !== undefined) {
			nextCursorByServer[result.entry.config.name] = data.nextCursor;
			if (serverName === result.entry.config.name) {
				nextCursor = data.nextCursor;
			}
		}
	}
	return {
		errors: errors.length === 0 ? undefined : errors,
		items,
		nextCursor,
		nextCursorByServer:
			Object.keys(nextCursorByServer).length === 0
				? undefined
				: nextCursorByServer,
	};
};

const outputError = (message: string): McpNormalizedResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
	owner: "registry",
	truncated: false,
});

const toJsonObject = (value: Record<string, unknown>): JsonObject =>
	isJsonObject(value) ? value : { type: "object" };

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

const matchesToolPattern = (pattern: string, toolName: string): boolean => {
	const parts = pattern.split("*");
	let cursor = 0;
	for (const [index, part] of parts.entries()) {
		if (part.length === 0) {
			continue;
		}
		const position = toolName.indexOf(part, cursor);
		if (
			position < 0 ||
			(index === 0 && position !== 0) ||
			(index === parts.length - 1 && position + part.length !== toolName.length)
		) {
			return false;
		}
		cursor = position + part.length;
	}
	return true;
};

const exposureForTool = (
	config: ResolvedMcpServerConfig,
	toolName: string
): "direct" | "hidden" => {
	const rules = config.toolExposure;
	if (rules === undefined) {
		return config.exposure ?? "direct";
	}
	const exact = rules[toolName];
	if (exact !== undefined) {
		return exact;
	}
	for (const [pattern, exposure] of Object.entries(rules)) {
		if (!pattern.includes("*")) {
			continue;
		}
		if (matchesToolPattern(pattern, toolName)) {
			return exposure;
		}
	}
	return config.exposure ?? "direct";
};

const defaultSdkClientFactory = (
	workspace: string,
	env: Record<string, string | undefined>,
	createOAuthProvider: McpClientFactoryDeps["createOAuthProvider"]
): ((config: ResolvedMcpServerConfig) => McpClient) => {
	let deps: McpClientFactoryDeps | undefined;
	return (config) => {
		if (isUndefined(deps)) {
			const environment = Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => !isUndefined(entry[1])
				)
			);
			deps = createSdkMcpClientDeps({
				clientInfo: { name: "wincode-cli", version: "0.1.0" },
				...(createOAuthProvider === undefined ? {} : { createOAuthProvider }),
				environment,
				workspace,
			});
		}
		return createSdkMcpClient(config, deps);
	};
};

export function createMcpRegistry(input: McpRegistryDeps): McpRegistry {
	const workspace = input.workspace;
	const env = input.env === undefined ? { ...process.env } : { ...input.env };
	const createClient =
		input.createClient ??
		defaultSdkClientFactory(workspace, env, input.createOAuthProvider);

	const serverEntries = new Map<string, ServerEntry>();
	const invalidStatuses = new Map<string, McpServerStatus>();
	const listeners = new Set<() => void>();
	const closeController = new AbortController();
	let closed = false;
	let initPromise: Promise<void> | undefined;
	let initialConnectionsPromise: Promise<void> = Promise.resolve();
	let initialConnectionsSettled = true;
	let initialCatalogReadyPromise: Promise<void> = Promise.resolve();
	let initialized = false;
	let refreshPromise: Promise<void> | undefined;
	const entryOperations = new Map<string, Promise<void>>();
	const reconnects = new Map<string, Promise<void>>();
	const toggles = new Map<string, Promise<void>>();
	let latestSnapshotId: McpSnapshotId | undefined;
	const activeSnapshotIds = new Set<McpSnapshotId>();
	const untrackedSnapshotIds = new Set<McpSnapshotId>();
	const snapshotReplacements = new Map<McpSnapshotId, McpCatalogSnapshot>();
	let catalogGeneration = 0;
	let snapshotCreated = false;

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
		if (isUndefined(client)) {
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

	const publishTools = (
		entry: ServerEntry,
		client: McpClient,
		tools: readonly McpClientTool[]
	): void => {
		if (entry.client !== client) {
			return;
		}
		entry.tools = tools;
		emit();
	};

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
		input.loadConfig({ env, refresh, workspace });

	const resourceEntriesFor = (serverName?: string): ServerEntry[] => {
		if (serverName === undefined) {
			return [...serverEntries.values()].filter(
				(entry) =>
					entry.state === "connected" &&
					(entry.config.exposure ?? "direct") === "direct"
			);
		}
		const entry = serverEntries.get(serverName);
		if (entry === undefined) {
			throw new Error("MCP server is unavailable");
		}
		return [entry];
	};

	const requestResourcePages = async <Page>(
		entries: readonly ServerEntry[],
		cursor: string | undefined,
		signal: AbortSignal | undefined,
		unavailableMessage: string,
		request: (
			client: McpClient,
			cursor: string | undefined,
			signal: AbortSignal
		) => Promise<Page> | undefined
	): Promise<readonly McpPageResult<Page>[]> =>
		Promise.all(
			entries.map(async (entry) => {
				const client = entry.client;
				if (
					entry.state !== "connected" ||
					(entry.config.exposure ?? "direct") !== "direct" ||
					client === undefined
				) {
					return { entry, error: unavailableMessage };
				}
				const signals = [catalogSignal(entry)];
				if (signal !== undefined) {
					signals.push(signal);
				}
				const pageRequest = request(client, cursor, AbortSignal.any(signals));
				if (pageRequest === undefined) {
					return { entry, error: unavailableMessage };
				}
				try {
					return { entry, page: await pageRequest };
				} catch (error) {
					return {
						entry,
						error: sanitizeMessage(
							entry.config,
							error,
							"MCP resource request failed"
						),
					};
				}
			})
		);

	const listResources = async (
		serverName?: string,
		cursor?: string,
		signal?: AbortSignal
	): Promise<McpResourcePage> => {
		await init();
		const entries = resourceEntriesFor(serverName);
		const pages = await requestResourcePages(
			entries,
			serverName === undefined ? undefined : cursor,
			signal,
			"MCP resources are unavailable",
			(client, requestCursor, requestSignal) =>
				client.listResources?.(requestCursor, requestSignal)
		);
		const collected = collectResourcePages(
			pages,
			serverName,
			(page) => ({ items: page.resources, nextCursor: page.nextCursor }),
			(entry, resource) => ({
				name: resource.name,
				server: entry.config.name,
				uri: resource.uri,
				...omitUndefined({
					description: resource.description,
					mimeType: resource.mimeType,
				}),
			})
		);
		return {
			resources: collected.items,
			...omitUndefined({
				nextCursor: collected.nextCursor,
				nextCursorByServer: collected.nextCursorByServer,
				errors: collected.errors,
			}),
		};
	};

	const listResourceTemplates = async (
		serverName?: string,
		cursor?: string,
		signal?: AbortSignal
	): Promise<McpResourceTemplatePage> => {
		await init();
		const entries = resourceEntriesFor(serverName);
		const pages = await requestResourcePages(
			entries,
			serverName === undefined ? undefined : cursor,
			signal,
			"MCP resource templates are unavailable",
			(client, requestCursor, requestSignal) =>
				client.listResourceTemplates?.(requestCursor, requestSignal)
		);
		const collected = collectResourcePages(
			pages,
			serverName,
			(page) => ({
				items: page.resourceTemplates,
				nextCursor: page.nextCursor,
			}),
			(entry, resource) => ({
				name: resource.name,
				server: entry.config.name,
				uriTemplate: resource.uriTemplate,
				...omitUndefined({
					description: resource.description,
					mimeType: resource.mimeType,
				}),
			})
		);
		return {
			resourceTemplates: collected.items,
			...omitUndefined({
				nextCursor: collected.nextCursor,
				nextCursorByServer: collected.nextCursorByServer,
				errors: collected.errors,
			}),
		};
	};

	const readResource = async (
		serverName: string,
		uri: string,
		signal?: AbortSignal
	): Promise<McpResourceRead> => {
		await init();
		const entry = serverEntries.get(serverName);
		if (
			isUndefined(entry) ||
			entry.state !== "connected" ||
			(entry.config.exposure ?? "direct") !== "direct" ||
			isUndefined(entry.client?.readResource)
		) {
			throw new Error("MCP resource is unavailable");
		}
		const signals = [catalogSignal(entry)];
		if (signal !== undefined) {
			signals.push(signal);
		}
		try {
			return {
				contents: await entry.client.readResource(
					uri,
					AbortSignal.any(signals)
				),
				server: entry.config.name,
			};
		} catch (error) {
			throw new Error(
				sanitizeMessage(entry.config, error, "MCP resource request failed")
			);
		}
	};

	const refreshEntryConfig = async (
		entry: ServerEntry,
		serverName: string
	): Promise<boolean> => {
		const configResult = await loadCurrentConfig(true);
		const config = configResult.servers[serverName];
		if (!isUndefined(config)) {
			entry.config = config;
			entry.source = configResult.serverSources?.[serverName];
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
		client.setToolsChangedListener((tools) =>
			publishTools(entry, client, tools)
		);
		entry.state = "connecting";
		entry.error = undefined;
		try {
			await client.connect(startupSignal(entry));
			if (closed) {
				await closeClient(entry);
				return;
			}
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
		} finally {
			emit();
		}
	};

	const doInit = async (): Promise<void> => {
		const configResult = await loadCurrentConfig();
		for (const [name, config] of Object.entries(configResult.servers)) {
			serverEntries.set(name, {
				client: undefined,
				config,
				source: configResult.serverSources?.[name],
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
				auth: "none",
				error: "Invalid MCP server configuration",
				exposure: "direct",
				name: invalid.name,
				source: configResult.serverSources?.[invalid.name],
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
		initialConnectionsSettled = false;
		initialConnectionsPromise = Promise.allSettled(connects).then(() => {
			initialConnectionsSettled = true;
		});
		initialCatalogReadyPromise = Promise.race([
			initialConnectionsPromise,
			Bun.sleep(10_000),
		]);
	};

	const init = (): Promise<void> => {
		if (isUndefined(initPromise)) {
			initPromise = doInit().then(() => {
				initialized = true;
			});
		}
		return initPromise;
	};

	const buildSnapshot = async (agent: AgentId): Promise<McpCatalogSnapshot> => {
		type Candidate = {
			client: McpClient;
			config: ResolvedMcpServerConfig;
			tool: McpClientTool;
		};
		const candidates: Candidate[] = [];
		for (const entry of serverEntries.values()) {
			if (isUndefined(entry.client) || entry.state !== "connected") {
				continue;
			}
			for (const tool of entry.tools) {
				if (exposureForTool(entry.config, tool.name) === "hidden") {
					continue;
				}
				candidates.push({
					client: entry.client,
					config: entry.config,
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
				serverName: candidate.config.name,
			});
			if (visibleCount < MAX_MCP_TOOL_COUNT) {
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
			id: toMcpSnapshotId(crypto.randomUUID()),
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
		if (!isUndefined(latestSnapshotId)) {
			activeSnapshotIds.delete(latestSnapshotId);
		}
		latestSnapshotId = snapshot.id;
	};

	const releaseSnapshot = (snapshot: McpCatalogSnapshot): void => {
		const replacement = snapshotReplacements.get(snapshot.id);
		if (!isUndefined(replacement)) {
			snapshotReplacements.delete(snapshot.id);
			releaseSnapshot(replacement);
		}
		if (snapshot.id === latestSnapshotId) {
			return;
		}
		activeSnapshotIds.delete(snapshot.id);
		untrackedSnapshotIds.delete(snapshot.id);
	};

	const createSnapshot = async (
		agent: AgentId,
		trackLatest = true
	): Promise<McpCatalogSnapshot> => {
		if (closed) {
			const snapshot: McpCatalogSnapshot = {
				agent,
				id: toMcpSnapshotId(crypto.randomUUID()),
				manifest: [],
				tools: new Map(),
			};
			retainSnapshot(snapshot, trackLatest);
			return snapshot;
		}
		await init();
		await initialCatalogReadyPromise;
		if (snapshotCreated) {
			const retryableEntries = [...serverEntries.values()].filter(
				(entry) =>
					entry.state === "degraded" ||
					(entry.state === "failed" &&
						entry.error !== "Invalid MCP server configuration")
			);
			await Promise.allSettled(
				retryableEntries.map((entry) =>
					runEntryOperation(entry.config.name, async () => {
						if (
							entry.state === "degraded" ||
							(entry.state === "failed" &&
								entry.error !== "Invalid MCP server configuration")
						) {
							await doReconnect(entry);
						}
					})
				)
			);
		}
		snapshotCreated = true;
		while (!closed) {
			const generation = catalogGeneration;
			const snapshot = await buildSnapshot(agent);
			if (generation === catalogGeneration) {
				retainSnapshot(snapshot, trackLatest);
				return snapshot;
			}
		}
		return {
			agent,
			id: toMcpSnapshotId(crypto.randomUUID()),
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

	const resolveExecutableSnapshot = (
		snapshot: McpCatalogSnapshot
	): McpCatalogSnapshot | undefined => {
		let current = snapshot;
		let replacement = snapshotReplacements.get(current.id);
		while (!isUndefined(replacement)) {
			current = replacement;
			replacement = snapshotReplacements.get(current.id);
		}
		if (
			!activeSnapshotIds.has(current.id) ||
			(current.id !== latestSnapshotId && !untrackedSnapshotIds.has(current.id))
		) {
			return;
		}
		return current;
	};

	const matchesCurrentToolContract = (
		previousSnapshot: McpCatalogSnapshot,
		refreshedSnapshot: McpCatalogSnapshot,
		toolName: string,
		previousTool: McpSnapshotTool
	): boolean => {
		const refreshedTool = refreshedSnapshot.tools.get(toolName);
		const previousContract = previousSnapshot.manifest.find(
			(item) => item.name === toolName
		);
		const refreshedContract = refreshedSnapshot.manifest.find(
			(item) => item.name === toolName
		);
		if (
			isUndefined(refreshedTool) ||
			refreshedTool.serverName !== previousTool.serverName ||
			refreshedTool.originalToolName !== previousTool.originalToolName ||
			isUndefined(previousContract) ||
			isUndefined(refreshedContract)
		) {
			return false;
		}
		return (
			previousContract.description === refreshedContract.description &&
			Bun.deepEquals(
				previousContract.inputSchema,
				refreshedContract.inputSchema,
				true
			)
		);
	};

	const recoverDegradedServer = async (
		snapshot: McpCatalogSnapshot,
		toolName: string,
		tool: McpSnapshotTool,
		entry: ServerEntry
	): Promise<McpCatalogSnapshot | string> => {
		// The failed call already returned an error. Recover before executing
		// this new request, but never replay the operation that just failed.
		let refreshedSnapshot: McpCatalogSnapshot;
		try {
			refreshedSnapshot = await createSnapshot(snapshot.agent, false);
		} catch (error) {
			return sanitizeMessage(entry.config, error, "MCP server recovery failed");
		}
		if (entry.state !== "connected" || isUndefined(entry.client)) {
			releaseSnapshot(refreshedSnapshot);
			return (
				entry.error ??
				`MCP server '${entry.config.name}' is not connected after reconnect`
			);
		}
		if (
			!matchesCurrentToolContract(snapshot, refreshedSnapshot, toolName, tool)
		) {
			releaseSnapshot(refreshedSnapshot);
			return `MCP tool '${toolName}' changed after reconnect; retry with a fresh Agent Turn`;
		}
		snapshotReplacements.set(snapshot.id, refreshedSnapshot);
		return refreshedSnapshot;
	};

	const executeConnectedTool = async (
		toolName: string,
		tool: McpSnapshotTool,
		entry: ServerEntry,
		input: unknown,
		signal?: AbortSignal
	): Promise<McpNormalizedResult> => {
		const timeout = AbortSignal.timeout(entry.config.timeout.execution);
		const signals: AbortSignal[] = [
			timeout,
			closeController.signal,
			entry.executionController.signal,
		];
		if (!isUndefined(signal)) {
			signals.push(signal);
		}
		const combined = AbortSignal.any(signals);
		try {
			const raw = await tool.client.callTool(
				tool.originalToolName,
				input,
				combined
			);
			return await normalizeMcpResultWithArtifacts(raw);
		} catch (error) {
			const message = executionError(
				toolName,
				timeout,
				signal,
				entry.config,
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

	const execute = async (
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<McpNormalizedResult> => {
		const executableSnapshot = resolveExecutableSnapshot(snapshot);
		if (isUndefined(executableSnapshot)) {
			return outputError("MCP tool snapshot is stale or not executable");
		}
		if (executableSnapshot !== snapshot) {
			return execute(executableSnapshot, toolName, input, signal);
		}
		const tool = snapshot.tools.get(toolName);
		if (isUndefined(tool)) {
			return outputError(`Unknown MCP tool '${toolName}'`);
		}
		const entry = serverEntries.get(tool.serverName);
		if (isUndefined(entry)) {
			return outputError(`MCP server '${tool.serverName}' is not enabled`);
		}
		if (entry.state === "degraded") {
			const recovered = await recoverDegradedServer(
				snapshot,
				toolName,
				tool,
				entry
			);
			if (typeof recovered === "string") {
				return outputError(recovered);
			}
			return execute(recovered, toolName, input, signal);
		}
		if (entry.state !== "connected" || entry.client !== tool.client) {
			return outputError(`MCP server '${tool.serverName}' is not enabled`);
		}
		return executeConnectedTool(toolName, tool, entry, input, signal);
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
		client.setToolsChangedListener((tools) =>
			publishTools(entry, client, tools)
		);
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
		if (isUndefined(config)) {
			await deactivateEntry(
				entry,
				"failed",
				"Invalid MCP server configuration"
			);
			return false;
		}
		const configChanged = !Bun.deepEquals(entry.config, config, true);
		entry.config = config;
		entry.source = configResult.serverSources?.[entry.config.name];
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
				source: configResult.serverSources?.[name],
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
				auth: "none",
				error: "Invalid MCP server configuration",
				exposure: "direct",
				name: invalid.name,
				source: configResult.serverSources?.[invalid.name],
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

	const initialize = async (waitForConnections = true): Promise<void> => {
		if (!initialized) {
			await init();
			if (waitForConnections) {
				await initialConnectionsPromise;
			}
			return;
		}
		if (waitForConnections && !initialConnectionsSettled) {
			await initialConnectionsPromise;
			return;
		}
		if (!isUndefined(refreshPromise)) {
			await refreshPromise;
			return;
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
		await refresh;
	};

	const reconnectInvalidEntry = async (serverName: string): Promise<void> => {
		const configResult = await loadCurrentConfig(true);
		const config = configResult.servers[serverName];
		if (isUndefined(config)) {
			emit();
			return;
		}
		if (serverEntries.has(serverName)) {
			return;
		}
		const entry: ServerEntry = {
			client: undefined,
			config,
			source: configResult.serverSources?.[serverName],
			error: undefined,
			executionController: new AbortController(),
			state: config.disabled ? "disabled" : "connecting",
			tools: [],
		};
		invalidStatuses.delete(serverName);
		serverEntries.set(serverName, entry);
		if (!config.disabled) {
			await connectEntry(entry);
		}
		emit();
	};

	const reconnectExistingEntry = async (
		entry: ServerEntry,
		serverName: string
	): Promise<void> => {
		if (!(await refreshEntryConfig(entry, serverName))) {
			return;
		}
		if (entry.config.disabled) {
			await deactivateEntry(entry, "disabled");
			return;
		}
		await doReconnect(entry);
	};

	const reconnect = (serverName: string): Promise<void> => {
		const inFlight = reconnects.get(serverName);
		if (!isUndefined(inFlight)) {
			return inFlight;
		}
		const run = runEntryOperation(serverName, async () => {
			await init();
			const entry = serverEntries.get(serverName);
			if (isUndefined(entry)) {
				if (invalidStatuses.has(serverName)) {
					await reconnectInvalidEntry(serverName);
				}
				return;
			}
			if (entry.state === "disabled" || entry.state === "connecting") {
				return;
			}
			await reconnectExistingEntry(entry, serverName);
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

	const oauthConfigFor = (
		serverName: string
	): Extract<ResolvedMcpServerConfig, { type: "remote" }> => {
		const config = serverEntries.get(serverName)?.config;
		if (
			config === undefined ||
			config.type !== "remote" ||
			config.auth !== "oauth"
		) {
			throw new Error(`MCP Server '${serverName}' does not use OAuth.`);
		}
		return config;
	};

	const login = async (
		serverName: string,
		readRedirectUrl?: McpOAuthRedirectReader
	): Promise<void> => {
		await init();
		const config = oauthConfigFor(serverName);
		if (input.loginOAuth === undefined) {
			throw new Error("MCP OAuth login is unavailable.");
		}
		await input.loginOAuth(config, readRedirectUrl);
		await reconnect(serverName);
	};

	const logout = async (serverName: string): Promise<void> => {
		await init();
		const config = oauthConfigFor(serverName);
		if (input.logoutOAuth === undefined) {
			throw new Error("MCP OAuth logout is unavailable.");
		}
		await input.logoutOAuth(config);
		await reconnect(serverName);
	};

	const toggle = (serverName: string): Promise<void> => {
		const inFlight = toggles.get(serverName);
		if (!isUndefined(inFlight)) {
			return inFlight;
		}
		const run = runEntryOperation(serverName, async () => {
			await init();
			const entry = serverEntries.get(serverName);
			if (isUndefined(entry)) {
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

	const authFor = (entry: ServerEntry): McpServerStatus["auth"] => {
		if (entry.config.type !== "remote" || entry.config.auth !== "oauth") {
			return "none";
		}
		if (entry.state === "connected") {
			return "authenticated";
		}
		return "required";
	};

	const getStatuses = (): readonly McpServerStatus[] => [
		...[...serverEntries.values()].map(
			(entry): McpServerStatus => ({
				auth: authFor(entry),
				error: entry.error,
				exposure: entry.config.exposure ?? "direct",
				name: entry.config.name,
				source: entry.source,
				state: entry.state,
				toolCount: entry.tools.length,
				transport: entry.config.type,
			})
		),
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
		if (!isUndefined(initPromise)) {
			try {
				await initPromise;
			} catch {
				// init is best-effort; individual connect failures are already surfaced
			}
		}
		await Promise.allSettled([...serverEntries.values()].map(closeClient));
		snapshotReplacements.clear();
		listeners.clear();
	};

	return {
		close,
		createSnapshot,
		execute,
		listResources,
		listResourceTemplates,
		readResource,
		releaseSnapshot,
		getStatuses,
		initialize,
		login,
		logout,
		reconnect,
		subscribe,
		toggle,
	};
}

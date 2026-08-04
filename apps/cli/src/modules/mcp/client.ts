import path from "node:path";
import {
	type CallToolResult,
	Client,
	type ListToolsRequest,
	StreamableHTTPClientTransport,
	type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ResolvedMcpServerConfig } from "./config";
import { sanitizeMessage } from "./sanitize";

export type McpClientTool = {
	description?: string;
	inputSchema: Record<string, unknown>;
	name: string;
};

export type McpClient = {
	callTool(
		name: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<CallToolResult>;
	close(): Promise<void>;
	connect(signal?: AbortSignal): Promise<void>;
	listTools(signal?: AbortSignal): Promise<readonly McpClientTool[]>;
	setToolsChangedListener(
		listener: (tools: readonly McpClientTool[]) => void
	): void;
};

export type McpStdioTransportOptions = {
	args: string[];
	command: string;
	cwd: string;
	env: Record<string, string>;
};

export type McpHttpTransportOptions = {
	requestInit: { headers: Record<string, string> };
};

export type McpSdkClient = {
	callTool(
		params: { name: string; arguments?: unknown },
		options?: { signal?: AbortSignal }
	): Promise<CallToolResult>;
	close(): Promise<void>;
	connect(
		transport: McpSdkTransport,
		options?: { signal?: AbortSignal }
	): Promise<void>;
	listTools(
		params: ListToolsRequest["params"] | undefined,
		options?: { signal?: AbortSignal }
	): Promise<{ tools: Tool[] }>;
};

export type McpSdkTransport = {
	close(): Promise<void>;
	start(): Promise<void>;
};

export type McpClientFactoryDeps = {
	createClient(options: {
		listChanged: {
			tools: {
				onChanged: (error: Error | null, tools: Tool[] | null) => void;
			};
		};
	}): McpSdkClient;
	createHttpTransport(
		url: URL,
		options: McpHttpTransportOptions
	): McpSdkTransport;
	createStartupSignal(timeoutMs: number): AbortSignal;
	createStdioTransport(options: McpStdioTransportOptions): McpSdkTransport;
	environment: Record<string, string>;
	workspace: string;
};

export class McpClientError extends Error {
	readonly serverName: string;

	constructor(serverName: string, message: string) {
		super(`${serverName}: ${message}`);
		this.name = "McpClientError";
		this.serverName = serverName;
	}
}

const toClientTool = (tool: Tool): McpClientTool => ({
	name: tool.name,
	inputSchema: tool.inputSchema,
	...(tool.description === undefined ? {} : { description: tool.description }),
});

const localTransportOptions = (
	config: Extract<ResolvedMcpServerConfig, { type: "local" }>,
	deps: McpClientFactoryDeps
): McpStdioTransportOptions => {
	const [command, ...args] = config.command;
	if (command === undefined) {
		throw new Error(`MCP server ${config.name} has an empty command`);
	}
	let cwd: string;
	if (config.cwd === undefined) {
		cwd = deps.workspace;
	} else if (path.isAbsolute(config.cwd)) {
		cwd = config.cwd;
	} else {
		cwd = path.normalize(path.resolve(deps.workspace, config.cwd));
	}
	return {
		command,
		args,
		cwd,
		env: { ...deps.environment, ...config.environment },
	};
};

const sanitizeError = (
	config: ResolvedMcpServerConfig,
	error: unknown
): McpClientError =>
	new McpClientError(
		config.name,
		sanitizeMessage(config, error, "unknown MCP client error")
	);

export function createSdkMcpClient(
	config: ResolvedMcpServerConfig,
	deps: McpClientFactoryDeps
): McpClient {
	let toolsChanged: ((tools: readonly McpClientTool[]) => void) | undefined;
	let client: McpSdkClient | undefined;

	const getClient = (): McpSdkClient => {
		if (client !== undefined) {
			return client;
		}
		client = deps.createClient({
			listChanged: {
				tools: {
					onChanged: (error, tools) => {
						if (error !== null || tools === null) {
							return;
						}
						toolsChanged?.(tools.map(toClientTool));
					},
				},
			},
		});
		return client;
	};

	const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			throw sanitizeError(config, error);
		}
	};

	return {
		async connect(signal?: AbortSignal) {
			const startup = deps.createStartupSignal(config.timeout.startup);
			const combined = signal ? AbortSignal.any([startup, signal]) : startup;
			const sdkClient = getClient();
			const transport =
				config.type === "local"
					? deps.createStdioTransport(localTransportOptions(config, deps))
					: deps.createHttpTransport(new URL(config.url), {
							requestInit: { headers: config.headers ?? {} },
						});
			try {
				await sdkClient.connect(transport, { signal: combined });
			} catch (error) {
				if (startup.aborted) {
					throw new McpClientError(config.name, "connect timed out");
				}
				throw sanitizeError(config, error);
			}
		},
		async close() {
			return guard(async () => getClient().close());
		},
		async listTools(signal?: AbortSignal) {
			return guard(async () => {
				const { tools } = await getClient().listTools(undefined, {
					signal,
				});
				return tools.map(toClientTool);
			});
		},
		async callTool(name: string, input: unknown, signal?: AbortSignal) {
			return guard(async () =>
				getClient().callTool({ name, arguments: input }, { signal })
			);
		},
		setToolsChangedListener(
			listener: (tools: readonly McpClientTool[]) => void
		) {
			toolsChanged = listener;
		},
	};
}

export type McpClientDepsInput = {
	clientInfo: { name: string; version: string };
	environment: Record<string, string>;
	workspace: string;
};

export function createSdkMcpClientDeps(
	input: McpClientDepsInput
): McpClientFactoryDeps {
	return {
		environment: input.environment,
		workspace: input.workspace,
		createClient: (options) => new Client(input.clientInfo, options),
		createStdioTransport: (options) => new StdioClientTransport(options),
		createHttpTransport: (url, options) =>
			new StreamableHTTPClientTransport(url, options),
		createStartupSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
	};
}

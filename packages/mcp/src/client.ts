import * as path from "node:path";
import {
	type CallToolResult,
	Client,
	type ListResourcesRequest,
	type ListResourceTemplatesRequest,
	type ListToolsRequest,
	type OAuthClientProvider,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplateType,
	StreamableHTTPClientTransport,
	type Tool,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { isNull, isUndefined, omitUndefined } from "@wincode/utils";
import type { ResolvedMcpServerConfig } from "./config";
import { sanitizeMessage } from "./sanitize";

export type McpClientTool = {
	description?: string;
	inputSchema: Record<string, unknown>;
	name: string;
};

export type McpClientResource = Resource;
export type McpClientResourceTemplate = ResourceTemplateType;
export type McpClientResourceContent = ReadResourceResult["contents"][number];
export type McpClientResourcePage = Readonly<{
	resources: readonly McpClientResource[];
	nextCursor?: string;
}>;
export type McpClientResourceTemplatePage = Readonly<{
	resourceTemplates: readonly McpClientResourceTemplate[];
	nextCursor?: string;
}>;

export type McpClient = {
	callTool(
		name: string,
		input: unknown,
		signal?: AbortSignal
	): Promise<CallToolResult>;
	close(): Promise<void>;
	connect(signal?: AbortSignal): Promise<void>;
	listTools(signal?: AbortSignal): Promise<readonly McpClientTool[]>;
	listResources?(
		cursor?: string,
		signal?: AbortSignal
	): Promise<McpClientResourcePage>;
	listResourceTemplates?(
		cursor?: string,
		signal?: AbortSignal
	): Promise<McpClientResourceTemplatePage>;
	readResource?(
		uri: string,
		signal?: AbortSignal
	): Promise<readonly McpClientResourceContent[]>;
	setToolsChangedListener(
		listener: (tools: readonly McpClientTool[]) => void
	): void;
};

export type McpStdioTransportOptions = {
	args: string[];
	command: string;
	cwd: string;
	env: Record<string, string>;
	stderr: "ignore";
};

export type McpHttpTransportOptions = {
	authProvider?: OAuthClientProvider;
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
	listResources?(
		params: ListResourcesRequest["params"] | undefined,
		options?: { signal?: AbortSignal }
	): Promise<{ resources: Resource[]; nextCursor?: string }>;
	listResourceTemplates?(
		params: ListResourceTemplatesRequest["params"] | undefined,
		options?: { signal?: AbortSignal }
	): Promise<{
		resourceTemplates: ResourceTemplateType[];
		nextCursor?: string;
	}>;
	readResource?(
		params: { uri: string },
		options?: { signal?: AbortSignal }
	): Promise<ReadResourceResult>;
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
	createOAuthProvider?: (
		config: Extract<ResolvedMcpServerConfig, { type: "remote" }>
	) => OAuthClientProvider;
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
	...omitUndefined({ description: tool.description }),
});

const localTransportOptions = (
	config: Extract<ResolvedMcpServerConfig, { type: "local" }>,
	deps: McpClientFactoryDeps
): McpStdioTransportOptions => {
	const [command, ...args] = config.command;
	if (isUndefined(command)) {
		throw new Error(`MCP server ${config.name} has an empty command`);
	}
	let cwd: string;
	if (isUndefined(config.cwd)) {
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
		stderr: "ignore",
	};
};

const transientHttpFailurePattern =
	/(?:\b408\b|\b425\b|\b429\b|\b5\d{2}\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network error)/iu;

const isTransientHttpFailure = (error: unknown): boolean =>
	transientHttpFailurePattern.test(
		error instanceof Error ? error.message : String(error)
	);

const retryIdempotentRequest = async <Result>(
	config: ResolvedMcpServerConfig,
	operation: () => Promise<Result>
): Promise<Result> => {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (
				config.type !== "remote" ||
				attempt === 2 ||
				!isTransientHttpFailure(error)
			) {
				throw error;
			}
			await Bun.sleep(150 * (attempt + 1));
		}
	}
	throw new Error("MCP request retry limit reached");
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
		if (!isUndefined(client)) {
			return client;
		}
		client = deps.createClient({
			listChanged: {
				tools: {
					onChanged: (error, tools) => {
						if (!isNull(error) || isNull(tools)) {
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
							...(config.auth === "oauth" &&
							deps.createOAuthProvider !== undefined
								? { authProvider: deps.createOAuthProvider(config) }
								: {}),
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
				const { tools } = await retryIdempotentRequest(config, () =>
					getClient().listTools(undefined, { signal })
				);
				return tools.map(toClientTool);
			});
		},
		async listResources(cursor?: string, signal?: AbortSignal) {
			return guard(async () => {
				const sdkClient = getClient();
				const listResources = sdkClient.listResources;
				if (isUndefined(listResources)) {
					throw new Error("MCP server does not support resources");
				}
				const result = await retryIdempotentRequest(config, () =>
					listResources.call(
						sdkClient,
						cursor === undefined ? undefined : { cursor },
						{ signal }
					)
				);
				return {
					resources: result.resources,
					...omitUndefined({ nextCursor: result.nextCursor }),
				};
			});
		},
		async listResourceTemplates(cursor?: string, signal?: AbortSignal) {
			return guard(async () => {
				const sdkClient = getClient();
				const listResourceTemplates = sdkClient.listResourceTemplates;
				if (isUndefined(listResourceTemplates)) {
					throw new Error("MCP server does not support resource templates");
				}
				const result = await retryIdempotentRequest(config, () =>
					listResourceTemplates.call(
						sdkClient,
						cursor === undefined ? undefined : { cursor },
						{ signal }
					)
				);
				return {
					resourceTemplates: result.resourceTemplates,
					...omitUndefined({ nextCursor: result.nextCursor }),
				};
			});
		},
		async readResource(uri: string, signal?: AbortSignal) {
			return guard(async () => {
				const sdkClient = getClient();
				const readResource = sdkClient.readResource;
				if (isUndefined(readResource)) {
					throw new Error("MCP server does not support resources");
				}
				const result = await retryIdempotentRequest(config, () =>
					readResource.call(sdkClient, { uri }, { signal })
				);
				return result.contents;
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
	createOAuthProvider?: McpClientFactoryDeps["createOAuthProvider"];
	environment: Record<string, string>;
	workspace: string;
};

export function createSdkMcpClientDeps(
	input: McpClientDepsInput
): McpClientFactoryDeps {
	return {
		...(input.createOAuthProvider === undefined
			? {}
			: { createOAuthProvider: input.createOAuthProvider }),
		environment: input.environment,
		workspace: input.workspace,
		createClient: (options) => new Client(input.clientInfo, options),
		createStdioTransport: (options) => new StdioClientTransport(options),
		createHttpTransport: (url, options) =>
			new StreamableHTTPClientTransport(url, options),
		createStartupSignal: (timeoutMs) => AbortSignal.timeout(timeoutMs),
	};
}

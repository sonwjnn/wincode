import * as path from "node:path";
import type { ToolCallOutput } from "@wincode/agent-core";
import type {
	PluginFactory,
	PluginLoadContext,
	PluginStatus,
	PluginStatusPanelActionContext,
	PluginStatusPanelRegistration,
} from "@wincode/coding-agent";
import open from "open";
import { z } from "zod";
import {
	createMcpOAuthProvider,
	loginMcpServer,
	logoutMcpServer,
	type McpSecretStore,
} from "../oauth";
import {
	createMcpRegistry,
	type McpOAuthRedirectReader,
	type McpRegistry,
	type McpRegistryDeps,
	type McpServerStatus,
} from "../registry";
import { createMcpToolExecutor, normalizeMcpResourceContents } from "../result";
import { createMcpConfigLoader } from "./config";

export type McpPluginDependencies = Readonly<
	Pick<McpRegistryDeps, "createClient" | "createOAuthProvider" | "env"> &
		Partial<
			Pick<McpRegistryDeps, "loadConfig" | "loginOAuth" | "logoutOAuth">
		> &
		Readonly<{ createSecretStore?: (userDataDir: string) => McpSecretStore }>
>;

const statusFor = (state: McpServerStatus["state"]): PluginStatus => {
	switch (state) {
		case "connected":
			return "success";
		case "connecting":
			return "pending";
		case "degraded":
			return "warning";
		case "failed":
			return "error";
		default:
			return "idle";
	}
};

const STATUS_ACTION_IDS = {
	exposure: "exposure",
	login: "login",
	logout: "logout",
	reconnect: "reconnect",
	toggle: "toggle",
} as const;

type StatusActionId =
	(typeof STATUS_ACTION_IDS)[keyof typeof STATUS_ACTION_IDS];

type StatusAction = Readonly<{
	id: StatusActionId;
	label: string;
	shortcut: "space";
}>;

const connectionActions = (
	server: McpServerStatus
): readonly StatusAction[] => {
	if (server.state === "connecting") {
		return [];
	}
	if (server.state === "degraded" || server.state === "failed") {
		return [
			{
				id: STATUS_ACTION_IDS.reconnect,
				label: "Reconnect",
				shortcut: "space",
			},
		];
	}
	return [
		{
			id: STATUS_ACTION_IDS.toggle,
			label: server.state === "disabled" ? "Enable" : "Disable",
			shortcut: "space",
		},
	];
};

const authenticationActions = (
	server: McpServerStatus
): readonly StatusAction[] => {
	if (server.auth === "required") {
		return [
			{ id: STATUS_ACTION_IDS.login, label: "Sign in", shortcut: "space" },
		];
	}
	if (server.auth === "authenticated") {
		return [
			{ id: STATUS_ACTION_IDS.logout, label: "Sign out", shortcut: "space" },
		];
	}
	return [];
};

const statusActions = (server: McpServerStatus): readonly StatusAction[] => [
	...connectionActions(server),
	...authenticationActions(server),
	{
		id: STATUS_ACTION_IDS.exposure,
		label: server.exposure === "direct" ? "Hide tools" : "Expose tools",
		shortcut: "space",
	},
];

const authenticationLabel = (auth: McpServerStatus["auth"]): string => {
	if (auth === "authenticated") {
		return "authenticated";
	}
	if (auth === "required") {
		return "auth required";
	}
	return "no auth";
};

const redirectReaderFor =
	(
		requestTextInput: PluginStatusPanelActionContext["requestTextInput"]
	): McpOAuthRedirectReader =>
	async (callback) => {
		const controller = new AbortController();
		try {
			const pastedUrl = requestTextInput(
				"Paste the full OAuth redirect URL if the browser cannot return to Wincode.",
				controller.signal
			).then((value) => {
				if (value === undefined) {
					throw new Error("OAuth sign-in was canceled.");
				}
				try {
					return new URL(value.trim());
				} catch {
					throw new Error("The OAuth redirect URL is invalid.");
				}
			});
			return await Promise.race([callback, pastedUrl]);
		} finally {
			controller.abort();
		}
	};

const persistServerField = async (
	context: PluginLoadContext,
	server: McpServerStatus,
	field: "enabled" | "exposure",
	value: boolean | "direct" | "hidden"
): Promise<void> => {
	const snapshot = await context.configFiles.getSnapshot("mcp");
	const origin =
		snapshot.sourceFor(["mcpServers", server.name, field]) ??
		snapshot.sourceFor(["mcpServers", server.name]);
	const trustedWorkspace = context.trustedProjectRoots?.some(
		(root) => path.resolve(root) === path.resolve(context.workspace)
	);
	let scope: "global" | "project" =
		origin?.scope === "project" || (origin === undefined && trustedWorkspace)
			? "project"
			: "global";
	if (field === "enabled" && scope === "global" && trustedWorkspace) {
		scope = "project";
	}
	if (scope === "project" && !trustedWorkspace) {
		throw new Error("Project MCP configuration requires a trusted project.");
	}
	const owner =
		server.source?.scope === scope
			? snapshot.sources.find(
					(source) =>
						source.scope === scope && source.path === server.source?.path
				)
			: undefined;
	const originSource =
		origin?.scope === scope
			? snapshot.sources.find(
					(source) => source.scope === scope && source.path === origin.path
				)
			: undefined;
	const target =
		owner ??
		originSource ??
		(scope === "project"
			? snapshot.sources.findLast((source) => source.scope === scope)
			: snapshot.sources.find((source) => source.scope === scope));
	if (target === undefined) {
		throw new Error(`Could not find the ${scope} MCP configuration file.`);
	}
	await context.configFiles.setValue(
		"mcp",
		scope,
		["mcpServers", server.name, field],
		value,
		target.path
	);
};

type StatusActionExecution = Readonly<{
	actionContext?: PluginStatusPanelActionContext;
	context: PluginLoadContext;
	registry: McpRegistry;
	server: McpServerStatus;
	serverName: string;
}>;

type StatusActionHandler = (execution: StatusActionExecution) => Promise<void>;

const statusActionHandlers = {
	[STATUS_ACTION_IDS.reconnect]: ({ registry, serverName }) =>
		registry.reconnect(serverName),
	[STATUS_ACTION_IDS.login]: ({ actionContext, registry, serverName }) =>
		registry.login(
			serverName,
			actionContext === undefined
				? undefined
				: redirectReaderFor(actionContext.requestTextInput)
		),
	[STATUS_ACTION_IDS.logout]: ({ registry, serverName }) =>
		registry.logout(serverName),
	[STATUS_ACTION_IDS.toggle]: async ({
		context,
		registry,
		server,
		serverName,
	}) => {
		await persistServerField(
			context,
			server,
			"enabled",
			server.state === "disabled"
		);
		await registry.toggle(serverName);
	},
	[STATUS_ACTION_IDS.exposure]: async ({ context, registry, server }) => {
		await persistServerField(
			context,
			server,
			"exposure",
			server.exposure === "direct" ? "hidden" : "direct"
		);
		await registry.initialize();
	},
} satisfies Record<StatusActionId, StatusActionHandler>;

const isStatusActionId = (actionId: string): actionId is StatusActionId =>
	Object.hasOwn(statusActionHandlers, actionId);

const createStatusPanel = (
	getRegistry: () => McpRegistry | undefined,
	context: PluginLoadContext
): PluginStatusPanelRegistration => ({
	emptyText: "No MCP servers",
	getSnapshot: () => {
		const statuses = getRegistry()?.getStatuses() ?? [];
		const connected = statuses.filter(
			({ state }) => state === "connected"
		).length;
		const hasFailures = statuses.some(
			({ state }) => state === "degraded" || state === "failed"
		);
		let status: PluginStatus = "idle";
		if (hasFailures) {
			status = "warning";
		} else if (connected > 0) {
			status = "success";
		}
		return {
			items: statuses.map((server) => {
				const sourceLabel =
					server.source?.scope === "plugin"
						? `Plugin ${server.source.path.slice("plugin:".length)}`
						: (server.source?.scope ?? "unknown source");
				return {
					actions: statusActions(server),
					detail: server.error ?? server.source?.path,
					id: server.name,
					label: server.name,
					status: statusFor(server.state),
					summary: `${server.toolCount} tools • ${server.transport} • ${server.exposure} • ${authenticationLabel(server.auth)} • ${sourceLabel}`,
				};
			}),
			status,
			summary: String(connected),
		};
	},
	id: "servers",
	indicatorLabel: "MCPs",
	refresh: async () => {
		await getRegistry()?.initialize();
	},
	runAction: async (serverName, actionId, actionContext) => {
		const registry = getRegistry();
		if (registry === undefined) {
			throw new Error("MCP registry is unavailable.");
		}
		const server = registry
			.getStatuses()
			.find((status) => status.name === serverName);
		if (server === undefined) {
			throw new Error(`MCP Server '${serverName}' is unavailable.`);
		}
		if (!isStatusActionId(actionId)) {
			throw new Error(`Unknown MCP status action '${actionId}'.`);
		}
		await statusActionHandlers[actionId]({
			...(actionContext === undefined ? {} : { actionContext }),
			context,
			registry,
			server,
			serverName,
		});
	},
	subscribe: (listener) =>
		getRegistry()?.subscribe(listener) ?? (() => undefined),
	title: "MCP Servers",
});

const failure = (errorText: string): ToolCallOutput => ({
	errorText,
	type: "failure",
});

/** Creates MCP's Plugin factory with injectable OAuth storage and runtime adapters. */
export const createMcpPluginFactory =
	(dependencies: McpPluginDependencies = {}): PluginFactory =>
	async (api, context) => {
		let registry: McpRegistry | undefined;
		const getRegistry = (): McpRegistry => {
			if (registry === undefined) {
				throw new Error("MCP registry has not started.");
			}
			return registry;
		};
		const plugin = api.definePlugin({ id: "mcp" });
		const secrets = dependencies.createSecretStore?.(context.userDataDir);
		const requireSecrets = (): McpSecretStore => {
			if (secrets === undefined) {
				throw new Error(
					"MCP OAuth requires an MCP secret store from the host."
				);
			}
			return secrets;
		};
		plugin.onStart(async () => {
			const nextRegistry = createMcpRegistry({
				...(dependencies.createClient === undefined
					? {}
					: { createClient: dependencies.createClient }),
				...(dependencies.createOAuthProvider === undefined
					? {
							createOAuthProvider: (config) =>
								createMcpOAuthProvider({
									oauth: config.oauth,
									secrets: requireSecrets(),
									serverName: config.name,
								}),
						}
					: { createOAuthProvider: dependencies.createOAuthProvider }),
				...(dependencies.env === undefined ? {} : { env: dependencies.env }),
				loadConfig:
					dependencies.loadConfig ??
					createMcpConfigLoader(
						context.configFiles,
						context.getMcpServerRegistrations
					),
				loginOAuth:
					dependencies.loginOAuth ??
					(async (config, readRedirectUrl) => {
						await loginMcpServer({
							openAuthorizationUrl: async (url) => {
								await open(url.toString());
							},
							oauth: config.oauth,
							...(readRedirectUrl === undefined ? {} : { readRedirectUrl }),
							secrets: requireSecrets(),
							serverName: config.name,
							serverUrl: config.url,
						});
					}),
				logoutOAuth:
					dependencies.logoutOAuth ??
					(async (config) => {
						await logoutMcpServer(requireSecrets(), config.name);
					}),
				workspace: context.workspace,
			});
			registry = nextRegistry;
			await nextRegistry.initialize(false);
		});
		plugin.onShutdown(async () => {
			const currentRegistry = registry;
			registry = undefined;
			await currentRegistry?.close();
		});
		plugin.registerStatusPanel(createStatusPanel(() => registry, context));
		plugin.registerCommand({
			description: "Enable, disable, and inspect MCP servers",
			name: "mcps",
			statusPanelId: "servers",
		});
		plugin.onBeforeAgentTurn(async (turn, registration) => {
			const currentRegistry = getRegistry();
			const execute = createMcpToolExecutor(currentRegistry.execute);
			const snapshot = await currentRegistry.createSnapshot(turn.agentId);
			turn.registerTurnCleanup?.(() =>
				currentRegistry.releaseSnapshot?.(snapshot)
			);
			registration.registerTool({
				name: "mcp_list_resources",
				description:
					"List resources exposed by connected, direct-exposure MCP servers. Pass a server and cursor to continue a paginated listing.",
				modelName: "mcp_list_resources",
				inputSchema: z
					.object({
						server: z.string().optional(),
						cursor: z.string().optional(),
					})
					.strict(),
				handler: async (input, toolContext) => ({
					output: await currentRegistry.listResources(
						input.server,
						input.cursor,
						toolContext.signal
					),
					type: "success",
				}),
			});
			registration.registerTool({
				name: "mcp_list_resource_templates",
				description:
					"List resource templates exposed by connected, direct-exposure MCP servers. Pass a server and cursor to continue a paginated listing.",
				modelName: "mcp_list_resource_templates",
				inputSchema: z
					.object({
						server: z.string().optional(),
						cursor: z.string().optional(),
					})
					.strict(),
				handler: async (input, toolContext) => ({
					output: await currentRegistry.listResourceTemplates(
						input.server,
						input.cursor,
						toolContext.signal
					),
					type: "success",
				}),
			});
			registration.registerTool({
				name: "mcp_read_resource",
				description:
					"Read a resource from a connected, direct-exposure MCP server. Oversized text includes a bounded excerpt and is saved to a private temporary artifact; images are preserved and other binary content is saved there.",
				modelName: "mcp_read_resource",
				inputSchema: z.object({ server: z.string(), uri: z.string() }).strict(),
				handler: async (input, toolContext) => {
					const result = await currentRegistry.readResource(
						input.server,
						input.uri,
						toolContext.signal
					);
					return {
						output: {
							server: result.server,
							contents: await normalizeMcpResourceContents(result.contents),
						},
						type: "success",
					};
				},
			});
			for (const entry of snapshot.manifest) {
				const tool = snapshot.tools.get(entry.name);
				if (tool === undefined) {
					continue;
				}
				registration.registerTool({
					description: entry.description,
					inputSchema: { jsonSchema: entry.inputSchema },
					modelName: entry.name,
					name: entry.name,
					handler: async (input, toolContext) => {
						if (execute === undefined) {
							return failure("MCP execution is unavailable.");
						}
						return execute(snapshot, entry.name, input, toolContext.signal);
					},
				});
			}
		});
	};

export const mcpPluginFactory = createMcpPluginFactory();
export default mcpPluginFactory;

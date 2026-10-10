import type { ToolCallOutput } from "@wincode/agent-core";
import type {
	PluginFactory,
	PluginStatus,
	PluginStatusPanelRegistration,
} from "@wincode/coding-agent";
import {
	createMcpRegistry,
	type McpRegistry,
	type McpRegistryDeps,
	type McpServerStatus,
} from "../registry";
import { createMcpToolExecutor } from "../result";
import { createMcpConfigLoader } from "./config";

export type McpPluginDependencies = Readonly<
	Pick<McpRegistryDeps, "createClient" | "env"> &
		Partial<Pick<McpRegistryDeps, "loadConfig">>
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

const statusActions = (
	state: McpServerStatus["state"]
): readonly Readonly<{ id: string; label: string; shortcut: "space" }>[] => {
	if (state === "connecting") {
		return [];
	}
	if (state === "degraded" || state === "failed") {
		return [{ id: "reconnect", label: "Reconnect", shortcut: "space" }];
	}
	return [
		{
			id: "toggle",
			label: state === "disabled" ? "Enable" : "Disable",
			shortcut: "space",
		},
	];
};

const createStatusPanel = (
	getRegistry: () => McpRegistry | undefined
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
			items: statuses.map((server) => ({
				actions: statusActions(server.state),
				detail: server.error,
				id: server.name,
				label: server.name,
				status: statusFor(server.state),
				summary: `${server.toolCount} tools • ${server.transport}`,
			})),
			status,
			summary: String(connected),
		};
	},
	id: "servers",
	indicatorLabel: "MCPs",
	refresh: async () => {
		await getRegistry()?.initialize();
	},
	runAction: async (serverName, actionId) => {
		const registry = getRegistry();
		if (registry === undefined) {
			throw new Error("MCP registry is unavailable.");
		}
		if (actionId === "reconnect") {
			await registry.reconnect(serverName);
			return;
		}
		if (actionId === "toggle") {
			await registry.toggle(serverName);
			return;
		}
		throw new Error(`Unknown MCP status action '${actionId}'.`);
	},
	subscribe: (listener) =>
		getRegistry()?.subscribe(listener) ?? (() => undefined),
	title: "MCP Servers",
});

const failure = (errorText: string): ToolCallOutput => ({
	errorText,
	type: "failure",
});

/** Creates MCP's complete public-Plugin factory without a host adapter. */
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
		plugin.onStart(async () => {
			const nextRegistry = createMcpRegistry({
				...(dependencies.createClient === undefined
					? {}
					: { createClient: dependencies.createClient }),
				...(dependencies.env === undefined ? {} : { env: dependencies.env }),
				loadConfig:
					dependencies.loadConfig ?? createMcpConfigLoader(context.config),
				workspace: context.workspace,
			});
			registry = nextRegistry;
			await nextRegistry.initialize();
		});
		plugin.onShutdown(async () => {
			const currentRegistry = registry;
			registry = undefined;
			await currentRegistry?.close();
		});
		plugin.registerStatusPanel(createStatusPanel(() => registry));
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

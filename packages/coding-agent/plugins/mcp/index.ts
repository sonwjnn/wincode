import type {
	ResolvedTool,
	ToolCallId,
	ToolCallOutput,
	ToolExecutorOptions,
} from "@wincode/agent-core";
import {
	createMcpRegistry,
	type McpRegistryDeps,
	type McpSnapshotTool,
} from "@wincode/mcp";
import { isUndefined, omitUndefined } from "@wincode/utils";
import type { McpToolProviderContext } from "@/modules/application/plugins/turn-context";
import {
	createMcpSessionCapability,
	type McpPluginResource,
} from "@/modules/mcp/capability";
import { createWincodeMcpConfigLoader } from "@/modules/mcp/config";
import { withBundledToolGate } from "@/modules/plugins/bundled-tools";
import { getPluginHostContext } from "@/modules/plugins/host-context";
import type { PluginFactory } from "@/modules/plugins/public";
import { evaluateGateWithAbort } from "@/modules/tool-gate/evaluate-with-abort";
import type { ConfigStore } from "@/shared/config/config-store";

export type McpPluginResourceDependencies = Omit<
	McpRegistryDeps,
	"loadConfig"
> &
	Readonly<{
		configRoot?: string;
		configStore?: ConfigStore;
		fs?: { readFile(path: string): Promise<string> };
		homeRoot?: string;
	}>;

/** Creates and owns the configured MCP Servers used by one application runtime. */
export const createMcpPluginResource = (
	dependencies: McpPluginResourceDependencies
): McpPluginResource => {
	const {
		configRoot,
		configStore,
		createClient,
		env,
		fs,
		homeRoot,
		workspace,
	} = dependencies;
	const registry = createMcpRegistry({
		...omitUndefined({ createClient, env }),
		loadConfig: createWincodeMcpConfigLoader(
			omitUndefined({ configRoot, configStore, fs, homeRoot })
		),
		workspace,
	});
	return Object.freeze({
		capability: Object.freeze(createMcpSessionCapability(registry)),
		close: () => registry.close(),
		initialize: () => registry.initialize(),
		registry,
	});
};

const createMcpTools = ({
	agentId,
	executeMcpTool,
	gate,
	mcpSnapshot: snapshot,
}: McpToolProviderContext): readonly ResolvedTool[] => {
	if (isUndefined(snapshot) || isUndefined(executeMcpTool)) {
		return [];
	}
	return snapshot.manifest.flatMap((entry) => {
		const tool: McpSnapshotTool | undefined = snapshot.tools.get(entry.name);
		if (isUndefined(tool)) {
			return [];
		}
		return [
			{
				definition: {
					description: entry.description,
					inputSchema: { jsonSchema: entry.inputSchema },
					name: entry.name,
				},
				execute: async (
					{ input, toolCallId }: { input: unknown; toolCallId: ToolCallId },
					{ signal }: ToolExecutorOptions = {}
				): Promise<ToolCallOutput> => {
					const outcome = await evaluateGateWithAbort(
						() =>
							gate.gate({
								agentDecision: tool.agentDecision,
								agentId,
								action: tool.logicalName,
								description: tool.description,
								family: "mcp",
								input,
								safety: tool.safety,
								serverDecision: tool.serverDecision,
								toolCallId,
								toolName: entry.name,
							}),
						signal
					);
					if (outcome.kind !== "allow") {
						return {
							errorText: outcome.errorText,
							type: "failure",
						};
					}
					return executeMcpTool(snapshot, entry.name, input, signal);
				},
			} satisfies ResolvedTool,
		];
	});
};

const mcpPlugin: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "mcp" });
	plugin.onBeforeAgentTurn((context, registration) => {
		const turn = getPluginHostContext<McpToolProviderContext>(context);
		if (turn === undefined) {
			return;
		}
		for (const tool of createMcpTools(turn)) {
			registration.registerTool(
				withBundledToolGate(
					{
						description: tool.definition.description,
						handler: (input, toolContext) =>
							tool.execute(
								{ input, toolCallId: toolContext.toolCallId },
								{ signal: toolContext.signal }
							),
						inputSchema: tool.definition.inputSchema,
						name: tool.definition.name,
					},
					"mcp",
					tool.definition.name
				)
			);
		}
	});
};

/** MCP is a bundled Plugin registered through the public Plugin API. */
export const mcpPluginFactory = mcpPlugin;

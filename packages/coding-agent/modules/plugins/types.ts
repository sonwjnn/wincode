import type { ToolExecutionMode } from "@wincode/agent-core";
import type {
	PluginCommandHandler,
	PluginInputSchema,
	PluginToolRegistration,
} from "./public";

export type PluginTool = Readonly<{
	description: string;
	exclusiveInBatch?: true;
	executionMode?: ToolExecutionMode;
	handler: PluginToolRegistration<PluginInputSchema>["handler"];
	inputSchema: PluginInputSchema;
	modelName?: string;
	name: string;
}>;

export type PluginCommand = Readonly<{
	description: string;
	handler?: PluginCommandHandler;
	name: string;
	statusPanelId?: string;
}>;

import type { ToolExecutionMode } from "@wincode/agent-core";
import type {
	PluginCommandArgumentCompletion,
	PluginCommandHandler,
	PluginInputSchema,
	PluginToolCallRenderer,
	PluginToolRegistration,
	PluginToolResultRenderer,
} from "./public";

export type PluginTool = Readonly<{
	description: string;
	exclusiveInBatch?: true;
	executionMode?: ToolExecutionMode;
	handler: PluginToolRegistration<PluginInputSchema>["handler"];
	inputSchema: PluginInputSchema;
	modelName?: string;
	name: string;
	ownsRowShell?: boolean;
	renderCall?: PluginToolCallRenderer;
	renderResult?: PluginToolResultRenderer;
}>;

export type PluginCommand = Readonly<{
	description: string;
	getArgumentCompletions?: PluginCommandArgumentCompletion;
	handler?: PluginCommandHandler;
	name: string;
	statusPanelId?: string;
}>;

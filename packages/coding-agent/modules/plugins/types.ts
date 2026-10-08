import type {
	PluginCommandHandler,
	PluginInputSchema,
	PluginToolRegistration,
} from "./public";

export type PluginTool = Readonly<{
	description: string;
	exclusiveInBatch?: true;
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

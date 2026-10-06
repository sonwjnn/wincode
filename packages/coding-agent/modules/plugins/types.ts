import type {
	PluginCommandRegistration,
	PluginInputSchema,
	PluginToolRegistration,
} from "./public";

export type PluginTool = Readonly<{
	description: string;
	handler: PluginToolRegistration<PluginInputSchema>["handler"];
	inputSchema: PluginInputSchema;
	name: string;
}>;

export type PluginCommand = Readonly<{
	description: string;
	handler: PluginCommandRegistration["handler"];
	name: string;
}>;

export type { PluginCommandContext, PluginToolContext } from "./public";

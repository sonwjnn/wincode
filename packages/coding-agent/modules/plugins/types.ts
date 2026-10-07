import type {
	PluginCommandRegistration,
	PluginInputSchema,
	PluginToolRegistration,
} from "./public";

export type PluginTool = Readonly<{
	description: string;
	exclusiveInBatch?: true;
	permissionAction?: string;
	permissionResource?: string;
	permissionDecision?: "allow" | "ask" | "deny";
	permissionSafety?: boolean;
	handler: PluginToolRegistration<PluginInputSchema>["handler"];
	inputSchema: PluginInputSchema;
	modelName?: string;
	name: string;
}>;

export type PluginCommand = Readonly<{
	description: string;
	handler: PluginCommandRegistration["handler"];
	name: string;
}>;

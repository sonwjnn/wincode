import type { z } from "zod";
import type {
	PluginCommandContext,
	PluginToolContext,
	PluginToolResult,
} from "./public";

export type PluginTool = Readonly<{
	description: string;
	handler: (
		input: unknown,
		context: PluginToolContext
	) => PluginToolResult | Promise<PluginToolResult>;
	inputSchema: z.ZodType;
	name: string;
}>;

export type PluginCommand = Readonly<{
	description: string;
	handler: (context: PluginCommandContext) => string | Promise<string>;
	name: string;
}>;

import type { z } from "zod";

export type PluginJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly PluginJsonValue[]
	| { readonly [key: string]: PluginJsonValue };

export type PluginToolResult = string | PluginJsonValue;

export type PluginLoadContext = Readonly<{
	sourcePath: string;
	workspace: string;
}>;

export type PluginSessionContext = Readonly<{
	sessionId: string;
	workspace: string;
}>;

export type PluginProcessContext = PluginLoadContext;

export type PluginToolContext = PluginSessionContext &
	Readonly<{
		signal: AbortSignal;
	}>;

export type PluginCommandContext = Readonly<{
	argument: string;
	sessionId?: string;
	workspace: string;
}>;

export type PluginToolRegistration<Schema extends z.ZodType> = Readonly<{
	description: string;
	handler: (
		input: z.output<Schema>,
		context: PluginToolContext
	) => PluginToolResult | Promise<PluginToolResult>;
	inputSchema: Schema;
	name: string;
}>;

export type PluginCommandRegistration = Readonly<{
	description: string;
	handler: (context: PluginCommandContext) => string | Promise<string>;
	name: string;
}>;

export type PluginSessionHook = (
	context: PluginSessionContext
) => void | Promise<void>;

export type PluginShutdownHook = (
	context: PluginProcessContext
) => void | Promise<void>;

export type PluginDefinitionAPI = Readonly<{
	onSessionStart: (handler: PluginSessionHook) => void;
	onSessionShutdown: (handler: PluginSessionHook) => void;
	onShutdown: (handler: PluginShutdownHook) => void;
	registerCommand: (command: PluginCommandRegistration) => void;
	registerTool: <Schema extends z.ZodType>(
		tool: PluginToolRegistration<Schema>
	) => void;
}>;

export type PluginAPI = Readonly<{
	definePlugin: (identity: Readonly<{ id: string }>) => PluginDefinitionAPI;
}>;

/** The default export of an enabled Plugin file. */
export type PluginFactory = (
	api: PluginAPI,
	context: PluginLoadContext
) => void | Promise<void>;

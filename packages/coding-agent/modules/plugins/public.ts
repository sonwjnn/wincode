import type {
	AgentId,
	AgentTurnId,
	ToolCallId,
	ToolCallOutput,
	ToolJsonSchema,
} from "@wincode/agent-core";
import type { z } from "zod";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkChildFactory,
} from "@/modules/sessions/sdk-contract";
import type { ExecutionMode } from "@/shared/execution-mode";

export type PluginJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly PluginJsonValue[]
	| { readonly [key: string]: PluginJsonValue };

/** The outcome a Plugin Tool returns to Wincode. */
export type PluginToolResult = ToolCallOutput;
export type PluginInputSchema = z.ZodType | ToolJsonSchema;

export type PluginPermissionDecision = "allow" | "ask" | "deny";
export type PluginPermissionResourceRules = Readonly<
	Record<string, PluginPermissionDecision>
>;
export type PluginPermissionRules = Readonly<
	Record<
		string,
		PluginPermissionDecision | PluginPermissionResourceRules | undefined
	>
>;
export type PluginAgentPermissionPolicy = Readonly<{
	rules: PluginPermissionRules;
	safety: boolean;
}>;

export type PluginLoadContext = Readonly<{
	sourcePath: string;
	workspace: string;
}>;

export type PluginSessionContext = Readonly<{
	executionMode?: ExecutionMode;
	sessionId: string;
	sessionSdk?: SessionSdkChildFactory;
	workspace: string;
}>;

export type PluginBeforeAgentTurnContext = PluginSessionContext &
	Readonly<{
		agentId: AgentId;
		capabilityCeiling?: SessionSdkCapabilityCeiling;
		getAgentPermissionPolicy?: () => Promise<PluginAgentPermissionPolicy>;
		registerTurnCleanup?: (cleanup: () => void) => void;
		signal: AbortSignal;
		turnId?: AgentTurnId;
	}>;

export type PluginProcessContext = PluginLoadContext;

export type PluginToolContext = PluginSessionContext &
	Readonly<{
		agentId: AgentId;
		signal: AbortSignal;
		toolCallId: ToolCallId;
		registerBackgroundWork: (work: Promise<unknown>) => void;
	}>;

export type PluginCommandContext = Readonly<{
	argument: string;
	sessionId?: string;
	workspace: string;
}>;

export type PluginToolRegistration<Schema extends PluginInputSchema> =
	Readonly<{
		description: string;
		exclusiveInBatch?: true;
		permissionAction?: string;
		permissionResource?: string;
		permissionDecision?: "allow" | "ask" | "deny";
		permissionSafety?: boolean;
		handler: (
			input: Schema extends z.ZodType ? z.output<Schema> : unknown,
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

export type PluginToolRegistrationAPI = Readonly<{
	registerTool: <Schema extends PluginInputSchema>(
		tool: PluginToolRegistration<Schema>
	) => void;
	unregisterTool: (name: string) => void;
}>;

export type PluginRegistrationAPI = PluginToolRegistrationAPI &
	Readonly<{
		registerCommand: (command: PluginCommandRegistration) => void;
	}>;

export type PluginSessionStartHook = (
	context: PluginSessionContext,
	api: PluginRegistrationAPI
) => void | Promise<void>;

export type PluginSessionShutdownHook = (
	context: PluginSessionContext
) => void | Promise<void>;

export type PluginBeforeAgentTurnHook = (
	context: PluginBeforeAgentTurnContext,
	api: PluginToolRegistrationAPI
) => void | Promise<void>;

export type PluginShutdownHook = (
	context: PluginProcessContext
) => void | Promise<void>;

export type PluginDefinitionAPI = PluginRegistrationAPI &
	Readonly<{
		registerResource: (name: string, resource: unknown) => void;
		onSessionStart: (handler: PluginSessionStartHook) => void;
		onSessionShutdown: (handler: PluginSessionShutdownHook) => void;
		onBeforeAgentTurn: (handler: PluginBeforeAgentTurnHook) => void;
		onShutdown: (handler: PluginShutdownHook) => void;
	}>;

export type PluginAPI = Readonly<{
	definePlugin: (identity: Readonly<{ id: string }>) => PluginDefinitionAPI;
}>;

/** The default export of an enabled Plugin file. */
export type PluginFactory = (
	api: PluginAPI,
	context: PluginLoadContext
) => void | Promise<void>;

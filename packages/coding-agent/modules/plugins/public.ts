import type {
	AgentDefinition,
	AgentId,
	AgentTurnId,
	ToolCallId,
	ToolCallOutput,
	ToolJsonSchema,
} from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai/models";
import type { z } from "zod";
import type { ExecutionMode } from "../../shared/execution-mode";
import type {
	SessionSdkAgentSource,
	SessionSdkCapabilityCeiling,
	SessionSdkOperations,
} from "../sessions/sdk-contract";

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

export type PluginConfigOrigin = Readonly<{
	path: string;
	scope: string;
}>;

export type PluginConfigDiagnostic = PluginConfigOrigin &
	Readonly<{
		code: "duplicate-config" | "parse-error" | "read-error" | "unsafe-key";
		message: string;
	}>;

export type PluginConfigSource = PluginConfigOrigin &
	Readonly<{ document: Readonly<Record<string, unknown>> }>;

export type PluginConfigSnapshot = Readonly<{
	diagnostics: readonly PluginConfigDiagnostic[];
	document: Readonly<Record<string, unknown>>;
	sourceFor: (path: readonly string[]) => PluginConfigOrigin | undefined;
	sources: readonly PluginConfigSource[];
}>;

/** Read-only access to the host's merged config, including refresh and provenance. */
export type PluginConfigReader = Readonly<{
	getSnapshot: () => Promise<PluginConfigSnapshot>;
	refreshSnapshot: () => Promise<PluginConfigSnapshot>;
}>;

export type PluginStatus = "idle" | "pending" | "success" | "warning" | "error";

export type PluginStatusAction = Readonly<{
	id: string;
	label: string;
	shortcut?: "space";
}>;

export type PluginStatusItem = Readonly<{
	actions?: readonly PluginStatusAction[];
	detail?: string;
	id: string;
	label: string;
	status: PluginStatus;
	summary?: string;
}>;

export type PluginStatusPanelSnapshot = Readonly<{
	items: readonly PluginStatusItem[];
	status?: PluginStatus;
	summary?: string;
}>;

/** Declarative host-rendered status and controls contributed by a Plugin. */
export type PluginStatusPanelRegistration = Readonly<{
	emptyText?: string;
	getSnapshot: () => PluginStatusPanelSnapshot;
	indicatorLabel?: string;
	id: string;
	refresh?: () => Promise<void>;
	runAction: (itemId: string, actionId: string) => Promise<void>;
	subscribe: (listener: () => void) => () => void;
	title: string;
}>;

export type PluginAgentScope = Exclude<SessionSdkAgentSource, "global">;

export type PluginAgentRegistration = Readonly<{
	agent: AgentDefinition;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	requiredTools?: readonly string[];
	source: Readonly<{
		path: string;
		projectRoot?: string;
		scope: PluginAgentScope;
	}>;
	tools?: readonly string[];
}>;

export type PluginLoadContext = Readonly<{
	config: PluginConfigReader;
	trustedProjectRoots?: readonly string[];
	sourcePath: string;
	userDataDir: string;
	workspace: string;
}>;

export type PluginSessionContext = Readonly<{
	executionMode?: ExecutionMode;
	sessionId: string;
	sessionSdk?: SessionSdkOperations;
	workspace: string;
}>;

export type PluginBeforeAgentTurnContext = PluginSessionContext &
	Readonly<{
		agentId: AgentId;
		capabilityCeiling?: SessionSdkCapabilityCeiling;
		registerTurnCleanup?: (cleanup: () => void) => void;
		signal: AbortSignal;
		turnId?: AgentTurnId;
	}>;

export type PluginProcessContext = Readonly<{
	sourcePath: string;
	workspace: string;
}>;

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
		handler: (
			input: Schema extends z.ZodType ? z.output<Schema> : unknown,
			context: PluginToolContext
		) => PluginToolResult | Promise<PluginToolResult>;
		inputSchema: Schema;
		modelName?: string;
		name: string;
	}>;

export type PluginCommandHandler = (
	context: PluginCommandContext
) => string | Promise<string>;

export type PluginCommandRegistration = Readonly<{
	description: string;
	name: string;
}> &
	(
		| Readonly<{ handler: PluginCommandHandler; statusPanelId?: never }>
		| Readonly<{ handler?: never; statusPanelId: string }>
	);

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
		registerAgent: (agent: PluginAgentRegistration) => void;
		registerResource: (name: string, resource: unknown) => void;
		registerStatusPanel: (panel: PluginStatusPanelRegistration) => void;
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

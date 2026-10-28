import type {
	AgentDefinition,
	AgentId,
	AgentTurnId,
	ToolCallId,
	ToolCallOutput,
	ToolJsonSchema,
} from "@wincode/agent-core";
import type {
	Provider,
	ProviderModelSelection,
	ThinkingLevel,
} from "@wincode/ai";
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

export type PluginMcpServerRegistration = Readonly<{
	config: PluginJsonValue;
	name: string;
	ownerPluginId: string;
}>;

export type PluginConfigFileStore = Readonly<{
	getSnapshot: (namespace: string) => Promise<PluginConfigSnapshot>;
	refreshSnapshot: (namespace: string) => Promise<PluginConfigSnapshot>;
	setValue: (
		namespace: string,
		scope: "global" | "project",
		path: readonly string[],
		value: PluginJsonValue | undefined,
		targetPath?: string
	) => Promise<PluginConfigSnapshot>;
}>;

export type PluginProviderConnectContext = Readonly<{
	requestTextInput: (
		prompt: string,
		signal: AbortSignal
	) => Promise<string | undefined>;
	signal: AbortSignal;
}>;

/** A trusted Plugin's factory and host-mediated connection interaction. */
export type PluginProviderRegistration = Readonly<{
	connect: (
		context: PluginProviderConnectContext
	) => Promise<PluginJsonValue | undefined>;
	createProvider: () => Provider;
	displayName: string;
	providerId: string;
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
export type PluginStatusPanelActionContext = Readonly<{
	requestTextInput: (
		prompt: string,
		signal: AbortSignal
	) => Promise<string | undefined>;
}>;

export type PluginStatusPanelRegistration = Readonly<{
	emptyText?: string;
	getSnapshot: () => PluginStatusPanelSnapshot;
	indicatorLabel?: string;
	id: string;
	refresh?: () => Promise<void>;
	runAction: (
		itemId: string,
		actionId: string,
		context?: PluginStatusPanelActionContext
	) => Promise<void>;
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
	configFiles: PluginConfigFileStore;
	getMcpServerRegistrations: () => readonly PluginMcpServerRegistration[];
	trustedProjectRoots?: readonly string[];
	sourcePath: string;
	/** Shared user-data root; Plugins choose and secure their own storage beneath it. */
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

/** Why compaction ran: an operator request, a threshold check, or overflow recovery. */
export type PluginCompactionTrigger = "manual" | "overflow" | "threshold";

export type PluginCompactionContext = PluginSessionContext &
	Readonly<{
		focus?: string;
		signal: AbortSignal;
		trigger: PluginCompactionTrigger;
		turnId?: AgentTurnId;
	}>;

/**
 * A pre-compaction decision. `cancel` refuses the compaction with its message.
 * `summary` supplies the handoff text instead of calling a summary model; the
 * Session Host still applies its own budgets, reduction and persistence rules.
 */
export type PluginBeforeCompactionResult =
	| Readonly<{ cancel: string; summary?: never }>
	| Readonly<{ cancel?: never; summary: string }>
	| undefined;

export type PluginCompactionCompletedContext = PluginCompactionContext &
	Readonly<{
		compactionId: string;
		estimatedTokensAfter: number;
		tokensBefore: number;
	}>;

export type PluginCompactionFailedContext = PluginCompactionContext &
	Readonly<{ error: string }>;

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

export type PluginBeforeCompactionHook = (
	context: PluginCompactionContext
) => PluginBeforeCompactionResult | Promise<PluginBeforeCompactionResult>;

export type PluginCompactionCompletedHook = (
	context: PluginCompactionCompletedContext
) => void | Promise<void>;

export type PluginCompactionFailedHook = (
	context: PluginCompactionFailedContext
) => void | Promise<void>;

export type PluginShutdownHook = (
	context: PluginProcessContext
) => void | Promise<void>;

export type PluginProcessStartHook = (
	context: PluginProcessContext
) => void | Promise<void>;

export type PluginDefinitionAPI = PluginRegistrationAPI &
	Readonly<{
		registerProvider: (provider: PluginProviderRegistration) => void;
		registerMcpServer: (name: string, config: PluginJsonValue) => void;
		registerAgent: (agent: PluginAgentRegistration) => void;
		registerResource: (name: string, resource: unknown) => void;
		registerStatusPanel: (panel: PluginStatusPanelRegistration) => void;
		onSessionStart: (handler: PluginSessionStartHook) => void;
		onSessionShutdown: (handler: PluginSessionShutdownHook) => void;
		onBeforeAgentTurn: (handler: PluginBeforeAgentTurnHook) => void;
		onBeforeCompaction: (handler: PluginBeforeCompactionHook) => void;
		onCompactionCompleted: (handler: PluginCompactionCompletedHook) => void;
		onCompactionFailed: (handler: PluginCompactionFailedHook) => void;
		onStart: (handler: PluginProcessStartHook) => void;
		onShutdown: (handler: PluginShutdownHook) => void;
	}>;

export type PluginAPI = Readonly<{
	definePlugin: (identity: Readonly<{ id: string }>) => PluginDefinitionAPI;
	/** Set the focused Interactive composer model for future Submissions. */
	setModel: (model: ProviderModelSelection) => Promise<boolean>;
	/** Set or clear the focused composer ThinkingLevel for future Submissions; unsupported levels are ignored. */
	setThinkingLevel: (level: ThinkingLevel | undefined) => void;
}>;

/** The default export of an enabled Plugin file. */
export type PluginFactory = (
	api: PluginAPI,
	context: PluginLoadContext
) => void | Promise<void>;

import {
	type AgentId,
	type AgentRole,
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnEvent,
	type AgentTurnFilePart,
	type AgentTurnId,
	type AgentTurnInterruptedEvent,
	type AgentTurnLifecycle,
	type AgentTurnMessage,
	type AgentTurnPart,
	type AgentTurnTerminalEvent,
	createAgentRuntime,
	createAgentTurnAbortEvent,
	createAgentTurnLifecycle,
	createOperationalFailure,
	getAgentTurnFailureDetails,
	isAgentInvariantError,
	isToolCallId,
	type ResolvedTool,
	type SessionMessageId,
	type SessionRecord,
	type ToolCallId,
	type ToolCallOutput,
	type ToolDefinition,
	type ToolExecutorOptions,
	type ToolFailureDetails,
	toSessionMessageId,
} from "@wincode/agent-core";
import { createModelClient } from "@wincode/ai/model-client";
import type { ModelTarget } from "@wincode/ai/model-target";
import {
	getErrorMessage,
	isNonEmptyString,
	isNull,
	isObjectLike,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import type { ReadonlyDeep, UnknownRecord } from "type-fest";
import {
	type ApplicationToolProviderFactory,
	createApplicationToolRegistry,
	type ToolProviderRegistration,
} from "@/modules/application/plugins/registry";
import type {
	CodingToolProviderContext,
	PluginToolProviderContext,
	ShellToolProviderContext,
	SkillToolProviderContext,
	TurnToolPluginContext,
} from "@/modules/application/plugins/turn-context";
import { createPluginTools } from "@/modules/plugins/tools";
import {
	formatSkillUserContext,
	type SkillRequestContext,
	sampleSkillResources,
	skillToolInputSchema,
} from "@/modules/skills";
import {
	type CodingToolName,
	type CodingToolRunnerOptions,
	codingToolCatalog,
	codingToolDefinitionFor,
	type EditMode,
	editInputSchemaForMode,
	type ShellPlatform,
	shellPlatformFromNode,
	type ToolResourceLimits,
	toCodingToolFailure,
	type VersionedEditingContext,
} from "@/modules/tools";
import type { ResolvedCodingAgent } from "../../agents/built-ins";
import type { SessionMessage } from "../message";
import { expandSessionMessagesForModel } from "../message";
import {
	formatAttachmentUnavailableMarker,
	getAttachmentReference,
} from "../storage/attachment-store";
import {
	buildTerminalSessionRecord,
	buildToolSessionRecord,
} from "../turn-records";

export type RuntimeFactory = () => AgentRuntime;

/** Composition-root default: the provider-neutral Agent Runtime. */
export const defaultRuntimeFactory: RuntimeFactory = () =>
	createAgentRuntime({ modelClient: createModelClient() });
const BASE_AGENT_INSTRUCTIONS =
	"You are a basic coding agent running in a user's CLI.\nAll file tools are limited to the CLI workspace.";

const HOST_SHELL_PLATFORM: ShellPlatform = shellPlatformFromNode(
	process.platform
);

const runtimeToolDefinition = (
	name: CodingToolName,
	shellPlatform: ShellPlatform,
	editMode?: EditMode,
	resourceLimits?: ToolResourceLimits
): ToolDefinition => {
	const definition = codingToolDefinitionFor(
		name,
		shellPlatform,
		resourceLimits
	);
	if (name !== "edit" || editMode === undefined) {
		return definition;
	}
	return {
		...definition,
		description: `${definition.description} Active Edit Mode: ${editMode}. Use only this mode; a different mode takes effect on the next Agent Turn.`,
		inputSchema: editInputSchemaForMode(editMode),
	};
};

const runtimeSkillToolDefinition: ToolDefinition = {
	description:
		"Load an available Skill for the current user turn by exact name.",
	inputSchema: skillToolInputSchema,
	name: "skill",
};

/** The application Tool Registry of runtime-eligible tools. */
const runCodingTool = async ({
	input,
	name,
	options,
}: {
	input: unknown;
	name: CodingToolName;
	options: {
		resourceLimits?: ToolResourceLimits;
		signal?: AbortSignal;
		versionedEditing?: VersionedEditingContext;
	};
}): Promise<ToolCallOutput> => {
	const runner = codingToolCatalog[name].run as (
		value: unknown,
		runnerOptions?: CodingToolRunnerOptions
	) => Promise<unknown>;
	try {
		return {
			output: await runner(input, options),
			type: "success",
		};
	} catch (error) {
		if (isAgentInvariantError(error)) {
			throw error;
		}
		const failure = toCodingToolFailure(error);
		return failure === undefined
			? {
					errorText: getErrorMessage(error, "Tool execution failed."),
					type: "failure",
				}
			: {
					errorText: getErrorMessage(error, "Tool execution failed."),
					failure,
					type: "failure",
				};
	}
};

export type { TurnToolPluginContext } from "@/modules/application/plugins/turn-context";
export type TurnToolResolver = (
	context: TurnToolPluginContext
) => Promise<readonly ResolvedTool[]>;

type CodingToolOptions = Readonly<{
	name: CodingToolName;
	resourceLimits?: ToolResourceLimits;
	versionedEditing?: VersionedEditingContext;
}>;

/** Executes selected coding tools directly; resource limits remain in force. */
const createCodingTool = ({
	name,
	resourceLimits,
	versionedEditing,
}: CodingToolOptions): ResolvedTool => ({
	definition: runtimeToolDefinition(
		name,
		HOST_SHELL_PLATFORM,
		versionedEditing?.editMode,
		resourceLimits
	),
	execute: async (
		{ input }: { input: unknown; toolCallId: ToolCallId },
		{ signal }: ToolExecutorOptions = {}
	): Promise<ToolCallOutput> =>
		runCodingTool({
			input,
			name,
			options: {
				...omitUndefined({ resourceLimits }),
				signal,
				versionedEditing,
			},
		}),
});

/** Resolves the selected coding tools with their captured resource limits. */
const createCodingTools = ({
	agentTools,
	resourceLimits,
	versionedEditing,
}: CodingToolProviderContext): readonly ResolvedTool[] =>
	agentTools
		.filter(
			(name): name is Exclude<CodingToolName, "shell"> => name !== "shell"
		)
		.map((name) =>
			createCodingTool({ name, resourceLimits, versionedEditing })
		);

const createShellTools = (
	context: ShellToolProviderContext
): readonly ResolvedTool[] =>
	context.agentTools.includes("shell")
		? [
				createCodingTool({
					name: "shell",
					resourceLimits: context.resourceLimits,
					versionedEditing: context.versionedEditing,
				}),
			]
		: [];

const createSkillTools = ({
	skillExecution,
	skillTool,
}: SkillToolProviderContext): readonly ResolvedTool[] => {
	if (isUndefined(skillTool) || isUndefined(skillExecution)) {
		return [];
	}
	const skill: ResolvedTool = {
		definition: {
			...runtimeSkillToolDefinition,
			description: skillTool.description,
		},
		execute: async ({
			input,
		}: {
			input: unknown;
			toolCallId: ToolCallId;
		}): Promise<ToolCallOutput> => {
			const parsed = skillToolInputSchema.safeParse(input);
			if (!parsed.success) {
				return {
					errorText: "Invalid skill input; expected { name }",
					type: "failure",
				};
			}
			const name = parsed.data.name;
			const result = skillExecution.activate(name, "agent");
			if (result.status === "loaded") {
				const resourcePaths = await sampleSkillResources(
					result.snapshot.baseDirectory
				);
				skillExecution.setResourceSample(name, resourcePaths);
				return {
					output: {
						baseDirectory: result.snapshot.baseDirectory,
						body: result.snapshot.body,
						contentHash: result.snapshot.contentHash,
						name,
						resourcePaths,
						source: "agent",
						status: "loaded",
					},
					type: "success",
				};
			}
			return { output: result, type: "success" };
		},
	};
	return [skill];
};

const selectCodingToolProviderContext = (
	context: TurnToolPluginContext
): CodingToolProviderContext => ({
	agentTools: context.agentTools,
	resourceLimits: context.resourceLimits,
	versionedEditing: context.versionedEditing,
});
const selectSkillToolProviderContext = (
	context: TurnToolPluginContext
): SkillToolProviderContext => ({
	skillExecution: context.skillExecution,
	skillTool: context.skillTool,
});

const codingProvider: ApplicationToolProviderFactory<TurnToolPluginContext> = (
	api
) => {
	api.registerToolProvider({
		id: "coding-tools",
		policyCategory: "coding",
		selectContext: selectCodingToolProviderContext,
		adapter: {
			policyCategory: "coding",
			resolve: createCodingTools,
		},
	});
	api.registerToolProvider({
		id: "shell-tools",
		policyCategory: "shell",
		selectContext: selectCodingToolProviderContext,
		adapter: {
			policyCategory: "shell",
			resolve: createShellTools,
		},
	});
};

const skillToolProvider: ToolProviderRegistration<
	TurnToolPluginContext,
	SkillToolProviderContext
> = {
	id: "skill-tools",
	policyCategory: "skill",
	selectContext: selectSkillToolProviderContext,
	adapter: {
		policyCategory: "skill",
		resolve: createSkillTools,
	},
};

const selectPluginToolProviderContext = (
	context: TurnToolPluginContext
): PluginToolProviderContext => ({
	...(context.agentId === undefined ? {} : { agentId: context.agentId }),
	existingToolNames: context.existingToolNames ?? [],
	...(context.pluginTools === undefined
		? {}
		: { pluginTools: context.pluginTools }),
	...(context.signal === undefined ? {} : { signal: context.signal }),
	...(context.pluginRuntime === undefined
		? {}
		: { registerBackgroundWork: context.pluginRuntime.registerBackgroundWork }),
	...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
	...(context.workspace === undefined ? {} : { workspace: context.workspace }),
});

const pluginToolsProvider: ApplicationToolProviderFactory<
	TurnToolPluginContext
> = (api) => {
	api.registerToolProvider({
		id: "plugin-tools",
		policyCategory: "plugin",
		selectContext: (context) => context,
		adapter: {
			policyCategory: "plugin",
			resolve: (context) =>
				createPluginTools(selectPluginToolProviderContext(context)),
		},
	});
};

export const createTurnToolRegistry = (
	providers: readonly ApplicationToolProviderFactory<TurnToolPluginContext>[] = []
) =>
	createApplicationToolRegistry({
		providers: [codingProvider, ...providers, pluginToolsProvider],
		nativeToolProviders: [skillToolProvider],
	});

const nativeToolRegistry = createTurnToolRegistry();

/** Resolves native coding/shell, Skill, and explicitly loaded file Plugin tools. */
export const resolveTurnTools: TurnToolResolver = (context) =>
	nativeToolRegistry.resolve(context);

const settledToolName = (
	type: string,
	toolName?: unknown
): string | undefined => {
	if (type === "dynamic-tool") {
		return isNonEmptyString(toolName) ? toolName : undefined;
	}
	if (type.startsWith("tool-")) {
		const name = type.slice("tool-".length);
		return isNonEmptyString(name) ? name : undefined;
	}
	return;
};

/** A terminal tool part from prior session turns. */
export type SettledSessionToolCallPart = {
	input?: unknown;
	toolCallId: ToolCallId;
	toolName?: string;
	type: string;
} & (
	| { output: unknown; state: "output-available" }
	| {
			errorText: string;
			failure?: ToolFailureDetails;
			state: "output-error";
	  }
);

/** Only settled tool calls are replayed into a new Agent Turn. */
export const isSettledSessionToolCallPart = (
	part: unknown
): part is SettledSessionToolCallPart => {
	if (!(isObjectLike(part) && "type" in part)) {
		return false;
	}
	const candidate = part as UnknownRecord;
	if (
		!isString(candidate.type) ||
		isUndefined(settledToolName(candidate.type, candidate.toolName))
	) {
		return false;
	}
	if (!isToolCallId(candidate.toolCallId)) {
		return false;
	}
	if (candidate.state === "output-available") {
		return "output" in candidate;
	}
	if (candidate.state === "output-error") {
		return isNonEmptyString(candidate.errorText);
	}
	return false;
};

type TurnToolCallPart = {
	input: unknown;
	toolCallId: ToolCallId;
	toolName: string;
	type: "tool-call";
};

/**
 * Converts one terminal session Tool part into its Assistant tool-call
 * request plus the `tool` role message that carries the settled result.
 */
const toToolCallParts = (
	part: SettledSessionToolCallPart,
	name: string
): {
	request: TurnToolCallPart;
	result: AgentTurnMessage["parts"][number];
} => {
	const toolCallId = part.toolCallId;
	const request = {
		input: part.input,
		toolCallId,
		toolName: name,
		type: "tool-call" as const,
	};
	if (part.state === "output-available") {
		return {
			request,
			result: {
				output: part.output,
				toolCallId,
				toolName: name,
				type: "tool-result",
			},
		};
	}
	return {
		request,
		result: {
			errorText: part.errorText,
			...omitUndefined({ failure: part.failure }),
			toolCallId: part.toolCallId,
			toolName: name,
			type: "tool-failure",
		},
	};
};

const toAssistantTurnMessages = (
	message: SessionMessage
): AgentTurnMessage[] => {
	const parts: AgentTurnPart[] = [];
	const results: AgentTurnMessage[] = [];
	for (const part of message.parts) {
		if (part.type === "text") {
			if (part.text.length > 0) {
				parts.push({ text: part.text, type: "text" });
			}
			continue;
		}
		if (part.type === "step-start" || part.type === "reasoning") {
			continue;
		}
		if (!isSettledSessionToolCallPart(part)) {
			continue;
		}
		const name = settledToolName(
			part.type,
			"toolName" in part ? part.toolName : undefined
		);
		if (isUndefined(name)) {
			continue;
		}
		const { request, result } = toToolCallParts(part, name);
		parts.push(request);
		results.push({
			id: toSessionMessageId(`tool-${request.toolCallId}`),
			parts: [result],
			role: "tool",
		});
	}
	if (parts.length === 0) {
		return [];
	}
	return [{ id: message.id, parts, role: "assistant" }, ...results];
};

const toUserTurnPart = (
	part: SessionMessage["parts"][number]
): AgentTurnPart | undefined => {
	if (part.type === "text") {
		return part.text.length > 0 ? { text: part.text, type: "text" } : undefined;
	}
	if (part.type !== "file") {
		return;
	}
	const reference = getAttachmentReference(part);
	if (!isNull(reference)) {
		return {
			text: formatAttachmentUnavailableMarker(reference, "omitted"),
			type: "text",
		};
	}
	const filePart: AgentTurnFilePart = {
		data: part.url,
		mediaType: part.mediaType,
		type: "file",
	};
	return filePart;
};

const toUserTurnMessages = (message: SessionMessage): AgentTurnMessage[] => {
	const parts = message.parts.flatMap((part) => {
		const modelPart = toUserTurnPart(part);
		return isUndefined(modelPart) ? [] : [modelPart];
	});
	return parts.length === 0 ? [] : [{ id: message.id, parts, role: "user" }];
};

const toAgentTurnMessages = (message: SessionMessage): AgentTurnMessage[] => {
	if (message.role === "user") {
		return toUserTurnMessages(message);
	}
	if (message.role === "assistant") {
		return toAssistantTurnMessages(message);
	}
	return [];
};

/**
 * Builds one Agent Turn from the resolved session send. The Model Target
 * is resolved by the caller (it needs authorization); the Agent instructions
 * are composed for the resolved Agent; `tools` carries the gated Resolved
 * Tools the runtime may invoke for this Agent.
 */
export const buildAgentTurn = ({
	agent,
	modelMessages,
	modelTarget,
	resolvedAgent,
	role,
	skill,
	systemInstructions,
	tools = [],
	turnId,
}: {
	agent: AgentId;
	modelMessages: readonly SessionMessage[];
	modelTarget: ModelTarget;
	resolvedAgent: ResolvedCodingAgent;
	role?: AgentRole;
	skill?: SkillRequestContext;
	systemInstructions?: string;
	tools?: readonly ResolvedTool[];
	turnId: AgentTurnId;
}): AgentTurn => {
	const messages =
		expandSessionMessagesForModel(modelMessages).flatMap(toAgentTurnMessages);
	const effectiveRole = role ?? "primary";
	if (!isUndefined(skill)) {
		// The Skill context belongs to the submission's own user message, which
		// is the last model message; a Skill-only submission records an empty
		// user message that the model input drops, so the context is appended
		// after history instead of attaching to a stale message.
		const skillContext = {
			id: toSessionMessageId("skill-context"),
			parts: [{ text: formatSkillUserContext(skill), type: "text" }],
			role: "user",
		} satisfies (typeof messages)[number];
		const currentUserMessage = modelMessages.at(-1);
		const lastMessage = messages.at(-1);
		if (
			currentUserMessage?.role === "user" &&
			lastMessage !== undefined &&
			lastMessage.id === currentUserMessage.id
		) {
			messages.splice(messages.length - 1, 0, skillContext);
		} else {
			messages.push(skillContext);
		}
	}
	return {
		agent: {
			id: agent,
			instructions:
				systemInstructions ??
				`${BASE_AGENT_INSTRUCTIONS}\n\n${resolvedAgent.instructions}`,
			role: effectiveRole,
		},
		id: turnId,
		input: { messages },
		model: modelTarget,
		tools,
	};
};

/**
 * The live projection of one Agent Turn execution for the session UI. It is
 * transient and never becomes a Session Record.
 */
export type SessionViewState = ReadonlyDeep<{
	lastEventType?: AgentTurnEvent["type"];
	lastSequence: number;
	reasoningText: string;
	status: "idle" | "streaming" | "terminal";
	text: string;
	turnId: AgentTurnId;
}>;

type AgentTurnEventConsumerOptions = {
	lifecycle?: AgentTurnLifecycle;
	onViewState?: (state: SessionViewState) => void;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	takeSteeringMessages?: () =>
		| readonly AgentTurnMessage[]
		| Promise<readonly AgentTurnMessage[]>;
	turn: AgentTurn;
	onEvent: (event: AgentTurnEvent) => void | Promise<void>;
	onTerminal: (event: AgentTurnTerminalEvent) => void | Promise<void>;
};
const isTerminalEvent = (
	event: AgentTurnEvent
): event is AgentTurnTerminalEvent =>
	event.type === "agent-turn-completed" ||
	event.type === "agent-turn-failed" ||
	event.type === "agent-turn-cancelled" ||
	event.type === "agent-turn-interrupted";

/**
 * The application-owned runtime boundary. It is the only function in the
 * session layer that iterates an Agent Runtime; projections and durable
 * checkpoint callbacks run in event order after lifecycle reduction.
 */
const consumeAgentTurnEvents = async ({
	lifecycle: providedLifecycle,
	onEvent,
	onTerminal,
	onViewState,
	runtime,
	signal,
	takeSteeringMessages,
	turn,
}: AgentTurnEventConsumerOptions): Promise<void> => {
	const lifecycle = providedLifecycle ?? createAgentTurnLifecycle(turn.id);
	let viewState: SessionViewState = {
		lastSequence: -1,
		reasoningText: "",
		status: "idle",
		text: "",
		turnId: turn.id,
	};
	const publishViewState = (event: AgentTurnEvent): void => {
		if (event.type === "text-delta") {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				status: "streaming",
				text: viewState.text + event.delta,
			};
		} else if (event.type === "reasoning-delta") {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				reasoningText: viewState.reasoningText + event.delta,
				status: "streaming",
			};
		} else {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				status: "streaming",
			};
		}
		try {
			onViewState?.(viewState);
		} catch {
			// Presentation subscribers are observational only.
		}
	};
	for await (const event of runtime.run(turn, {
		...omitUndefined({ takeSteeringMessages }),
		signal,
	})) {
		if (
			signal?.aborted &&
			!isTerminalEvent(event) &&
			event.type !== "agent-turn-started"
		) {
			break;
		}
		if (isTerminalEvent(event)) {
			viewState = {
				...viewState,
				lastEventType: event.type,
				lastSequence: event.sequence,
				status: "terminal",
			};
			try {
				onViewState?.(viewState);
			} catch {
				// Presentation subscribers are observational only.
			}
			await onTerminal(event);
			return;
		}
		lifecycle.apply(event);
		publishViewState(event);
		await onEvent(event);
	}
};

/**
 * Application-owned durability hook: receives the Session Record for a
 * terminal Agent Turn Event and persists it as one semantic checkpoint. The
 * hook runs before the terminal display chunk is emitted, so the checkpoint
 * is durable before the executor observes the terminal outcome.
 */
export type CheckpointCommitter = (
	record: SessionRecord
) => Promise<void> | void;

const CHECKPOINT_FAILURE_MESSAGE =
	"The Agent Turn outcome could not be persisted.";

const createLostExecutionEvent = (
	turn: AgentTurn,
	sequence: number
): AgentTurnInterruptedEvent => ({
	failure: createOperationalFailure({
		code: "interrupted",
		details: getAgentTurnFailureDetails(turn),
		retry: "immediate",
		source: "runtime",
	}),
	finishedAt: Date.now(),
	reason: "lost-execution",
	sequence,
	turnId: turn.id,
	type: "agent-turn-interrupted",
});

const resolveMissingTerminalEvent = (
	signal: AbortSignal | undefined,
	turn: AgentTurn,
	lastSequence: number
): AgentTurnTerminalEvent =>
	isUndefined(signal)
		? createLostExecutionEvent(turn, lastSequence + 1)
		: createAgentTurnAbortEvent(turn, signal, lastSequence + 1);

const terminalEventForOutcome = (
	event: AgentTurnTerminalEvent,
	turn: AgentTurn,
	signal: AbortSignal | undefined
): AgentTurnTerminalEvent =>
	signal?.aborted
		? createAgentTurnAbortEvent(turn, signal, event.sequence)
		: event;

export const runAgentTurnToText = async ({
	getAssistantMessageId,
	onCheckpoint,
	onEvent,
	onTerminal,
	onToolCheckpoint,
	onViewState,
	runtime,
	signal,
	sourceUserMessageId,
	takeSteeringMessages,
	turn,
}: {
	getAssistantMessageId?: () => SessionMessageId;
	onCheckpoint?: CheckpointCommitter;
	onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
	onTerminal?: (event: AgentTurnTerminalEvent) => void | Promise<void>;
	onToolCheckpoint?: CheckpointCommitter;
	onViewState?: (state: SessionViewState) => void;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	sourceUserMessageId?: SessionMessageId;
	takeSteeringMessages?: () =>
		| readonly SessionMessage[]
		| Promise<readonly SessionMessage[]>;
	turn: AgentTurn;
}): Promise<string> => {
	let assistantText = "";
	let terminal: AgentTurnTerminalEvent | undefined;
	let lastSequence = -1;
	let completedToolCalls = 0;
	const startedTools = new Map<
		string,
		{ readonly input: unknown; readonly toolName: string }
	>();
	const commit = async (
		committer: CheckpointCommitter | undefined,
		record: SessionRecord | undefined
	): Promise<void> => {
		if (isUndefined(committer) || isUndefined(record)) {
			return;
		}
		try {
			await committer(record);
		} catch (error) {
			if (isAgentInvariantError(error)) {
				throw error;
			}
			throw new Error(CHECKPOINT_FAILURE_MESSAGE, { cause: error });
		}
	};
	await consumeAgentTurnEvents({
		onEvent: async (event) => {
			lastSequence = Math.max(lastSequence, event.sequence);
			if (event.type === "text-delta") {
				assistantText += event.delta;
			}
			if (event.type === "tool-call-started") {
				startedTools.set(event.toolCallId, {
					input: event.input,
					toolName: event.toolName,
				});
			}
			if (event.type === "tool-call-finished") {
				const started = startedTools.get(event.toolCallId);
				if (!isUndefined(started)) {
					completedToolCalls += 1;
					await commit(
						onToolCheckpoint,
						buildToolSessionRecord({
							event,
							input: started.input,
							sourceUserMessageId,
							turn,
						})
					);
					startedTools.delete(event.toolCallId);
				}
			}
			await onEvent?.(event);
		},
		onTerminal: (event) => {
			lastSequence = Math.max(lastSequence, event.sequence);
			terminal = event;
		},
		onViewState,
		runtime,
		signal,
		...omitUndefined({
			takeSteeringMessages: isUndefined(takeSteeringMessages)
				? undefined
				: async () =>
						(await takeSteeringMessages()).flatMap(toAgentTurnMessages),
		}),
		turn,
	});
	const terminalEvent = terminalEventForOutcome(
		terminal ?? resolveMissingTerminalEvent(signal, turn, lastSequence),
		turn,
		signal
	);
	const record = buildTerminalSessionRecord({
		assistantMessageId: getAssistantMessageId?.(),
		assistantText,
		hasCompletedToolCalls: completedToolCalls > 0,
		event: terminalEvent,
		sourceUserMessageId,
		turn,
	});
	await commit(onCheckpoint, record);
	await onTerminal?.(terminalEvent);
	if (terminalEvent.type === "agent-turn-completed") {
		return assistantText;
	}
	throw new Error(terminalEvent.failure.message);
};

import {
	type AgentId,
	type AgentRole,
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnDelegation,
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
import type { McpCatalogSnapshot } from "@wincode/mcp";
import type {
	DelegationExecutor,
	SubmitResultExecutor,
} from "@wincode/subagents";
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
	createApplicationToolRegistry,
	type Plugin,
	type ToolProviderRegistration,
} from "@/modules/application/plugins/registry";
import type {
	CodingToolProviderContext,
	ShellToolProviderContext,
	SkillToolProviderContext,
	TurnToolPluginContext,
} from "@/modules/application/plugins/turn-context";
import {
	createPluginTools,
	type PluginToolContext,
} from "@/modules/plugins/tools";
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
import { mcpPlugin } from "@/plugins/mcp";
import { subagentsPlugin } from "@/plugins/subagents";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";
import type { ResolvedCodingAgent } from "../../agents/built-ins";
import { evaluateGateWithAbort } from "../../tool-gate/evaluate-with-abort";
import type { ToolGate } from "../../tool-gate/tool-gate";
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

const isSloppyCodingInput = (value: unknown): boolean =>
	isObjectLike(value) && "mode" in value && value.mode === "sloppy";

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
		"Load a permitted Skill for the current user turn by exact name.",
	inputSchema: skillToolInputSchema,
	name: "skill",
};

/** The application Tool Registry of runtime-eligible tools. */
const runCodingToolThroughGate = async ({
	input,
	name,
	options,
}: {
	input: unknown;
	name: CodingToolName;
	options: {
		allowExternalPath: boolean;
		allowSloppy?: boolean;
		approvedExternalPaths?: readonly string[];
		approvedWorkspacePaths?: readonly string[];
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

/**
 * The application Tool Gate plus its resource-profile resolver, supplied
 * together so every runtime-armed Tool is executable only through the Gate.
 */
export type RuntimeGatedTooling = {
	gate: ToolGate;
	resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
	delegate?: DelegationExecutor<SessionId, DelegationTaskId>;
	submitResult?: SubmitResultExecutor;
	delegationTaskId?: DelegationTaskId;
	registerChildAbort?: (
		toolCallId: ToolCallId,
		abort: () => void
	) => () => void;
	mcpSnapshot?: McpCatalogSnapshot;
	executeMcpTool?: TurnToolPluginContext["executeMcpTool"];
	versionedEditing?: VersionedEditingContext;
};
type GatedCodingToolOptions = Readonly<{
	agentId?: AgentId;
	gate: ToolGate;
	resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
	resourceLimits?: ToolResourceLimits;
	versionedEditing?: VersionedEditingContext;
}> &
	(
		| Readonly<{
				family: "coding";
				name: Exclude<CodingToolName, "shell">;
		  }>
		| Readonly<{ family: "shell"; name: "shell" }>
	);

/** Keeps coding and shell calls on their distinct Tool Gate family paths. */
const createGatedCodingTool = ({
	agentId,
	family,
	gate,
	name,
	resolveResourceLimits,
	resourceLimits,
	versionedEditing,
}: GatedCodingToolOptions): ResolvedTool => ({
	definition: runtimeToolDefinition(
		name,
		HOST_SHELL_PLATFORM,
		versionedEditing?.editMode,
		resourceLimits
	),
	execute: async (
		{ input, toolCallId }: { input: unknown; toolCallId: ToolCallId },
		{ signal }: ToolExecutorOptions = {}
	): Promise<ToolCallOutput> => {
		const toolCall = { input, toolCallId };
		const gateCall =
			family === "coding"
				? {
						agentId,
						family,
						toolCall: { ...toolCall, toolName: name },
					}
				: { agentId, family, toolCall };
		const outcome = await evaluateGateWithAbort(
			() => gate.gate(gateCall),
			signal
		);
		if (outcome.kind !== "allow") {
			return {
				errorText: outcome.errorText ?? "Tool call was blocked",
				type: "failure",
			};
		}
		const approvedInput = outcome.input ?? input;
		return runCodingToolThroughGate({
			input: approvedInput,
			name,
			options: {
				allowExternalPath: !isUndefined(outcome.input),
				allowSloppy: isSloppyCodingInput(approvedInput),
				...omitUndefined({
					approvedWorkspacePaths: outcome.approvedWorkspacePaths,
					approvedExternalPaths: outcome.approvedExternalPaths,
					allowCrossSession:
						outcome.approvedCrossSession === true ? true : undefined,
					resourceLimits: isUndefined(resolveResourceLimits)
						? undefined
						: await resolveResourceLimits(agentId),
				}),
				signal,
				versionedEditing,
			},
		});
	},
});

/**
 * Resolves visible coding tools with actual-call Tool Gate evaluation before
 * the runner executes. Aborts short-circuit pending approvals; the runtime
 * drops any outcome belonging to an aborted turn.
 */
const createCodingTools = ({
	agentId,
	agentTools,
	gate,
	resolveResourceLimits,
	resourceLimits,
	versionedEditing,
}: CodingToolProviderContext): readonly ResolvedTool[] =>
	agentTools
		.filter(
			(name): name is Exclude<CodingToolName, "shell"> => name !== "shell"
		)
		.map((name) =>
			createGatedCodingTool({
				agentId,
				family: "coding",
				gate,
				name,
				resolveResourceLimits,
				resourceLimits,
				versionedEditing,
			})
		);

const createShellTools = (
	context: ShellToolProviderContext
): readonly ResolvedTool[] =>
	context.agentTools.includes("shell")
		? [
				createGatedCodingTool({
					agentId: context.agentId,
					family: "shell",
					gate: context.gate,
					name: "shell",
					resolveResourceLimits: context.resolveResourceLimits,
					resourceLimits: context.resourceLimits,
					versionedEditing: context.versionedEditing,
				}),
			]
		: [];

const createSkillTools = ({
	agentId,
	gate,
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
		execute: async (
			{ input, toolCallId }: { input: unknown; toolCallId: ToolCallId },
			{ signal }: ToolExecutorOptions = {}
		): Promise<ToolCallOutput> => {
			const parsed = skillToolInputSchema.safeParse(input);
			if (!parsed.success) {
				return {
					errorText: "Invalid skill input; expected { name }",
					type: "failure",
				};
			}
			const name = parsed.data.name;
			const entry = skillExecution.catalog.entries.find(
				({ name: entryName }) => entryName === name
			);
			const outcome = await evaluateGateWithAbort(
				() =>
					gate.gate({
						agentId,
						available: !isUndefined(entry),
						description: entry?.description ?? `Activate Skill ${name}`,
						family: "skill",
						name,
						toolCallId,
					}),
				signal
			);
			if (outcome.kind !== "allow") {
				skillExecution.markRejected(name);
				return { output: { name, status: "rejected" }, type: "success" };
			}
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
	agentId: context.agentId,
	agentTools: context.agentTools,
	gate: context.gate,
	resolveResourceLimits: context.resolveResourceLimits,
	resourceLimits: context.resourceLimits,
	versionedEditing: context.versionedEditing,
});
const selectSkillToolProviderContext = (
	context: TurnToolPluginContext
): SkillToolProviderContext => ({
	agentId: context.agentId,
	gate: context.gate,
	skillExecution: context.skillExecution,
	skillTool: context.skillTool,
});

const codingPlugin: Plugin<TurnToolPluginContext> = (api) => {
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
): PluginToolContext => ({
	...(context.agentId === undefined ? {} : { agentId: context.agentId }),
	existingToolNames: context.existingToolNames ?? [],
	gate: context.gate,
	...(context.resolvePluginPermission === undefined
		? {}
		: { permissionForAction: context.resolvePluginPermission }),
	...(context.pluginRuntime === undefined
		? {}
		: { runtime: context.pluginRuntime }),
	...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
	...(context.workspace === undefined ? {} : { workspace: context.workspace }),
});

const pluginToolsPlugin: Plugin<TurnToolPluginContext> = (api) => {
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

const applicationToolRegistry = createApplicationToolRegistry({
	plugins: [codingPlugin, mcpPlugin, subagentsPlugin, pluginToolsPlugin],
	nativeToolProviders: [skillToolProvider],
});

/** Resolves the single immutable set of tools visible to one Agent Turn. */
export const resolveTurnTools = (
	context: TurnToolPluginContext
): Promise<readonly ResolvedTool[]> => applicationToolRegistry.resolve(context);

/** Creates the Session Delegation runtime registered by the built-in Plugin. */
export const createApplicationSessionDelegationRuntime =
	applicationToolRegistry.createSessionDelegationRuntime;

const settledToolName = (
	type: string,
	toolName?: unknown
): string | undefined => {
	if (type === "dynamic-tool") {
		return isNonEmptyString(toolName) ? toolName : undefined;
	}
	if (
		type === "tool-skill" ||
		type === "tool-delegate" ||
		type === "tool-submit_result"
	) {
		if (type === "tool-skill") {
			return "skill";
		}
		if (type === "tool-delegate") {
			return "delegate";
		}
		return "submit_result";
	}
	if (type === "tool-read") {
		return "read";
	}
	if (type === "tool-write") {
		return "write";
	}
	if (type === "tool-edit") {
		return "edit";
	}
	if (type === "tool-glob") {
		return "glob";
	}
	if (type === "tool-grep") {
		return "grep";
	}
	if (type === "tool-shell") {
		return "shell";
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
	delegation,
}: {
	agent: AgentId;
	delegation?: AgentTurnDelegation;
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
	const effectiveRole = isUndefined(delegation)
		? (role ?? "primary")
		: "subagent";
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
		...omitUndefined({ delegation }),
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
	delegation?: AgentTurn["delegation"];
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
	takeFollowUpMessages?: () =>
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
	takeFollowUpMessages,
	turn,
}: AgentTurnEventConsumerOptions): Promise<void> => {
	const lifecycle = providedLifecycle ?? createAgentTurnLifecycle(turn.id);
	let viewState: SessionViewState = {
		delegation: turn.delegation,
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
		...omitUndefined({ takeFollowUpMessages, takeSteeringMessages }),
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
	takeFollowUpMessages,
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
	takeFollowUpMessages?: () =>
		| readonly SessionMessage[]
		| Promise<readonly SessionMessage[]>;
	turn: AgentTurn;
}): Promise<string> => {
	let assistantText = "";
	let checkpointedAssistantTextLength = 0;
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
			takeFollowUpMessages: isUndefined(takeFollowUpMessages)
				? undefined
				: async () => {
						const messages = await takeFollowUpMessages();
						if (messages.length > 0) {
							checkpointedAssistantTextLength = assistantText.length;
						}
						return messages.flatMap(toAgentTurnMessages);
					},
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
		assistantText: assistantText.slice(checkpointedAssistantTextLength),
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

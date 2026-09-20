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
	agentIdSchema,
	createAgentTurnAbortEvent,
	createAgentTurnLifecycle,
	createOperationalFailure,
	createToolRegistry,
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
	type ToolRegistry,
	toSessionMessageId,
} from "@wincode/agent-core";
import { createAiSdkAgentRuntime } from "@wincode/agent-runtime-ai-sdk";
import type { ModelTarget } from "@wincode/ai/model-target";
import {
	type CodingToolName,
	codingToolDefinitionFor,
	type EditMode,
	editInputSchemaForMode,
	runCodingTool,
	type ToolResourceLimits,
	toCodingToolFailure,
	type VersionedEditingContext,
} from "@wincode/coding-tools";
import {
	getErrorMessage,
	isNonEmptyString,
	isNull,
	isObjectLike,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import {
	formatSkillUserContext,
	type SkillExecution,
	type SkillRequestContext,
	type SkillToolDefinition,
	skillToolInputSchema,
} from "@wincode/skills";
import { sampleSkillResources } from "@wincode/skills/filesystem";
import type { ReadonlyDeep, UnknownRecord } from "type-fest";
import { z } from "zod";
import type { McpCatalogSnapshot, McpSnapshotTool } from "@/modules/mcp";
import type { ResolvedCodingAgent } from "../../agents/built-ins";
import type { GateOutcome, ToolGate } from "../../tool-gate/tool-gate";
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

/** Composition-root default: the private AI SDK Agent Runtime adapter. */
export const defaultRuntimeFactory: RuntimeFactory = () =>
	createAiSdkAgentRuntime();
const BASE_AGENT_INSTRUCTIONS =
	"You are a basic coding agent running in a user's CLI.\nAll file tools are limited to the CLI workspace.";

/** Coding, Skill, MCP, and delegation Tools are composed by the CLI. */
const RUNTIME_CODING_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"shell",
] as const;
export type RuntimeCodingToolName = (typeof RUNTIME_CODING_TOOL_NAMES)[number];
export type RuntimeToolName = RuntimeCodingToolName | "delegate" | "skill";

const isRuntimeCodingToolName = (name: string): name is RuntimeCodingToolName =>
	(RUNTIME_CODING_TOOL_NAMES as readonly string[]).includes(name);
const isSloppyCodingInput = (value: unknown): boolean =>
	isObjectLike(value) && "mode" in value && value.mode === "sloppy";

const runtimeToolDefinition = (
	name: RuntimeCodingToolName,
	editMode?: EditMode
): ToolDefinition => {
	const definition = codingToolDefinitionFor(name);
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
export const runtimeToolRegistry: ToolRegistry = createToolRegistry([
	...RUNTIME_CODING_TOOL_NAMES.map((name) => runtimeToolDefinition(name)),
	runtimeSkillToolDefinition,
]);

const runCodingToolThroughGate = async ({
	input,
	name,
	options,
}: {
	input: unknown;
	name: RuntimeCodingToolName;
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
	try {
		return {
			output: await runCodingTool(name, input, options),
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
export type GatedCodingToolsDeps = {
	/** The resolved Agent identity used for policy evaluation. */
	agentId?: AgentId;
	/** The tools the resolved Agent may use; deny-filtered by policy already. */
	agentTools: readonly CodingToolName[];
	gate: ToolGate;
	mcpSnapshot?: McpCatalogSnapshot;
	executeMcpTool?: (
		snapshot: McpCatalogSnapshot,
		toolName: string,
		input: unknown,
		signal?: AbortSignal
	) => Promise<ToolCallOutput>;
	resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
	skillExecution?: SkillExecution;
	skillTool?: SkillToolDefinition;
	delegate?: DelegationExecutor;
	parentTurnId?: AgentTurnId;
	versionedEditing?: VersionedEditingContext;
};

/**
 * The application Tool Gate plus its resource-profile resolver, supplied
 * together so every runtime-armed Tool is executable only through the Gate.
 */
export type RuntimeGatedTooling = {
	gate: ToolGate;
	resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
	delegate?: DelegationExecutor;
	registerChildAbort?: (
		toolCallId: ToolCallId,
		abort: () => void
	) => () => void;
	mcpSnapshot?: McpCatalogSnapshot;
	executeMcpTool?: GatedCodingToolsDeps["executeMcpTool"];
	versionedEditing?: VersionedEditingContext;
};
export type DelegationRequest = {
	readonly agent: AgentId;
	readonly parentToolCallId: ToolCallId;
	readonly parentTurnId: AgentTurnId;
	readonly prompt: string;
};

export type DelegationExecutor = (
	request: DelegationRequest,
	signal: AbortSignal | undefined
) => Promise<string>;

const ABORTED_TOOL_TEXT = "Tool call aborted";

/**
 * Settles a Gate evaluation against the executor abort signal: an aborted
 * execution denies the pending evaluation immediately instead of awaiting an
 * approval that can no longer be answered.
 */
const evaluateGateWithAbort = (
	evaluate: () => Promise<GateOutcome>,
	signal: AbortSignal | undefined
): Promise<GateOutcome> => {
	if (isUndefined(signal)) {
		return evaluate();
	}
	if (signal.aborted) {
		return Promise.resolve({ errorText: ABORTED_TOOL_TEXT, kind: "deny" });
	}
	return new Promise<GateOutcome>((resolve) => {
		let settled = false;
		const settle = (outcome: GateOutcome): void => {
			if (!settled) {
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(outcome);
			}
		};
		const onAbort = (): void => {
			settle({ errorText: ABORTED_TOOL_TEXT, kind: "deny" });
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void evaluate().then(settle, (error: unknown) => {
			settle(
				signal.aborted
					? { errorText: ABORTED_TOOL_TEXT, kind: "deny" }
					: {
							errorText: getErrorMessage(error, "Tool execution failed."),
							kind: "deny",
						}
			);
		});
	});
};

const delegationInputSchema = z.object({
	agent: agentIdSchema,
	prompt: z.string().min(1),
});

const createDelegationTool = (
	delegate: DelegationExecutor,
	parentTurnId: AgentTurnId
): ResolvedTool => ({
	definition: {
		description:
			"Delegate a focused task to a configured Subagent and return its result.",
		inputSchema: delegationInputSchema,
		name: "delegate",
	},
	execute: async (
		{ input, toolCallId },
		{ signal }: ToolExecutorOptions = {}
	): Promise<ToolCallOutput> => {
		const parsed = delegationInputSchema.safeParse(input);
		if (!parsed.success) {
			return {
				errorText: "Invalid delegation input; expected { agent, prompt }",
				type: "failure",
			};
		}
		try {
			return {
				output: await delegate(
					{
						agent: parsed.data.agent,
						parentToolCallId: toolCallId,
						parentTurnId,
						prompt: parsed.data.prompt,
					},
					signal
				),
				type: "success",
			};
		} catch (error) {
			if (isAgentInvariantError(error)) {
				throw error;
			}
			return {
				errorText: getErrorMessage(error, "Tool execution failed."),
				type: "failure",
			};
		}
	},
});

const createMcpTools = (
	snapshot: McpCatalogSnapshot | undefined,
	executeMcpTool: GatedCodingToolsDeps["executeMcpTool"],
	gate: ToolGate,
	agentId: AgentId | undefined
): readonly ResolvedTool[] => {
	if (isUndefined(snapshot) || isUndefined(executeMcpTool)) {
		return [];
	}
	return snapshot.manifest.flatMap((entry) => {
		const tool: McpSnapshotTool | undefined = snapshot.tools.get(entry.name);
		if (isUndefined(tool)) {
			return [];
		}
		return [
			{
				definition: {
					description: entry.description,
					inputSchema: { jsonSchema: entry.inputSchema },
					name: entry.name,
				},
				execute: async (
					{ input, toolCallId }: { input: unknown; toolCallId: ToolCallId },
					{ signal }: ToolExecutorOptions = {}
				): Promise<ToolCallOutput> => {
					const outcome = await evaluateGateWithAbort(
						() =>
							gate.gate({
								agentDecision: tool.agentDecision,
								agentId,
								action: tool.logicalName,
								description: tool.description,
								family: "mcp",
								input,
								safety: tool.safety,
								serverDecision: tool.serverDecision,
								toolCallId,
								toolName: entry.name,
							}),
						signal
					);
					if (outcome.kind !== "allow") {
						return {
							errorText: outcome.errorText,
							type: "failure",
						};
					}
					return executeMcpTool(snapshot, entry.name, input, signal);
				},
			} satisfies ResolvedTool,
		];
	});
};
/**
 * Composes one Resolved Tool per visible runtime-eligible coding family. Each

 * executor evaluates the actual Tool Call through the application Tool Gate
 * (allow, ask, deny, rejection, actual-resource evaluation, resource-profile
 * ceilings) before the runner executes; a Resolved Tool therefore never
 * reaches the Agent Runtime with an ungated executable. The executor abort
 * signal short-circuits a pending Gate evaluation; approvals themselves are
 * settled by the application stop path, and every outcome of an aborted turn
 * is dropped by the runtime, preserving cancellation semantics.
 */
export const createGatedCodingTools = ({
	agentId,
	agentTools,
	delegate,
	executeMcpTool,
	gate,
	mcpSnapshot,
	parentTurnId,
	resolveResourceLimits,
	skillExecution,
	skillTool,
	versionedEditing,
}: GatedCodingToolsDeps): readonly ResolvedTool[] => {
	const codingTools = agentTools
		.filter(isRuntimeCodingToolName)
		.map((name) => ({
			definition: runtimeToolDefinition(name, versionedEditing?.editMode),
			execute: async (
				{ input, toolCallId }: { input: unknown; toolCallId: ToolCallId },
				{ signal }: ToolExecutorOptions = {}
			): Promise<ToolCallOutput> => {
				const outcome = await evaluateGateWithAbort(
					() =>
						gate.gate({
							agentId,
							family: "coding",
							toolCall: { input, toolCallId, toolName: name },
						}),
					signal
				);
				if (outcome.kind !== "allow") {
					return {
						errorText: outcome.errorText ?? "Tool call was blocked",
						type: "failure",
					};
				}
				return runCodingToolThroughGate({
					input: outcome.input ?? input,
					name,
					options: {
						allowExternalPath: !isUndefined(outcome.input),
						allowSloppy: isSloppyCodingInput(outcome.input ?? input),
						...(outcome.approvedWorkspacePaths === undefined
							? {}
							: { approvedWorkspacePaths: outcome.approvedWorkspacePaths }),
						...(outcome.approvedExternalPaths === undefined
							? {}
							: { approvedExternalPaths: outcome.approvedExternalPaths }),
						...(isUndefined(resolveResourceLimits)
							? {}
							: {
									resourceLimits: await resolveResourceLimits(agentId),
								}),
						signal,
						versionedEditing,
					},
				});
			},
		}));
	const tools = [
		...codingTools,
		...createMcpTools(mcpSnapshot, executeMcpTool, gate, agentId),
	];
	if (isUndefined(skillTool) || isUndefined(skillExecution)) {
		if (!(isUndefined(delegate) || isUndefined(parentTurnId))) {
			tools.push(createDelegationTool(delegate, parentTurnId));
		}
		return tools;
	}
	const skill = {
		definition: {
			...runtimeToolRegistry.require("skill"),
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
	} satisfies ResolvedTool;
	tools.push(skill);
	if (!(isUndefined(delegate) || isUndefined(parentTurnId))) {
		tools.push(createDelegationTool(delegate, parentTurnId));
	}
	return tools;
};

const settledToolName = (
	type: string,
	toolName?: unknown
): string | undefined => {
	if (type === "dynamic-tool") {
		return isNonEmptyString(toolName) ? toolName : undefined;
	}
	if (type === "tool-skill" || type === "tool-delegate") {
		return type === "tool-skill" ? "skill" : "delegate";
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
			...(part.failure === undefined ? {} : { failure: part.failure }),
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
		messages.push({
			id: toSessionMessageId("skill-context"),
			parts: [{ text: formatSkillUserContext(skill), type: "text" }],
			role: "user",
		});
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
	takeSteeringMessages?: () => readonly AgentTurnMessage[];
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
	onCheckpoint?: CheckpointCommitter;
	onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
	onTerminal?: (event: AgentTurnTerminalEvent) => void | Promise<void>;
	onToolCheckpoint?: CheckpointCommitter;
	onViewState?: (state: SessionViewState) => void;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	sourceUserMessageId?: SessionMessageId;
	takeSteeringMessages?: () => readonly SessionMessage[];
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
				: () => takeSteeringMessages().flatMap(toAgentTurnMessages),
		}),
		turn,
	});
	const terminalEvent = terminalEventForOutcome(
		terminal ?? resolveMissingTerminalEvent(signal, turn, lastSequence),
		turn,
		signal
	);
	const record = buildTerminalSessionRecord({
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

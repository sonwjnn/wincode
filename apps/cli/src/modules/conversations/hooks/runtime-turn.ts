import {
	AgentInvariantError,
	type AgentRole,
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnDelegation,
	type AgentTurnInterruptedEvent,
	type AgentTurnLifecycle,
	type AgentTurnMessage,
	type AgentTurnPart,
	type AgentTurnTerminalEvent,
	CONVERSATION_RECORD_VERSION,
	type ConversationMessageRecord,
	type ConversationRecord,
	type ConversationToolCallPart,
	createAgentTurnAbortEvent,
	createAgentTurnLifecycle,
	createOperationalFailure,
	createToolRegistry,
	getAgentTurnFailureDetails,
	isAgentInvariantError,
	normalizeOperationalFailure,
	type ResolvedTool,
	type ToolCallOutput,
	type ToolDefinition,
	type ToolExecutorOptions,
	type ToolRegistry,
} from "@wincode/agent-core";
import { createAiSdkAgentRuntime } from "@wincode/agent-runtime-ai-sdk";
import {
	type AgentId,
	agentIdSchema,
	type CodingAgentUIMessage,
	getSystemInstructionsForAgent,
	type McpToolManifest,
	type ResolvedAgentRuntime,
} from "@wincode/ai";
import type { ModelTarget } from "@wincode/ai/model-target";
import { normalizeModelUsage } from "@wincode/ai/model-usage";
import {
	type CodingToolName,
	codingToolDefinitionFor,
	runCodingTool,
	type ToolResourceLimits,
} from "@wincode/coding-tools";
import {
	formatSkillUserContext,
	type SkillExecution,
	type SkillRequestContext,
	type SkillToolDefinition,
	skillToolInputSchema,
} from "@wincode/skills";
import { sampleSkillResources } from "@wincode/skills/filesystem";
import type { UIMessageChunk } from "ai";
import { z } from "zod";
import type { McpCatalogSnapshot, McpSnapshotTool } from "@/modules/mcp";
import type { GateOutcome, ToolGate } from "../../tool-gate/tool-gate";
import {
	type ConversationViewState,
	consumeAgentTurnEvents,
} from "../conversation-controller";

export type RuntimeFactory = () => AgentRuntime;

/** Composition-root default: the private AI SDK Agent Runtime adapter. */
export const defaultRuntimeFactory: RuntimeFactory = () =>
	createAiSdkAgentRuntime();

/**
 * The coding Tool families the Agent Runtime path can execute today. Every
 * other family keeps the legacy agent loop until its own tracer slice lands.
 */
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

const runtimeToolDefinition = (name: RuntimeCodingToolName): ToolDefinition =>
	codingToolDefinitionFor(name);

const runtimeSkillToolDefinition: ToolDefinition = {
	description:
		"Load a permitted Skill for the current user turn by exact name.",
	inputSchema: skillToolInputSchema,
	name: "skill",
};

/** The application Tool Registry of runtime-eligible tools. */
export const runtimeToolRegistry: ToolRegistry = createToolRegistry([
	...RUNTIME_CODING_TOOL_NAMES.map(runtimeToolDefinition),
	runtimeSkillToolDefinition,
]);

const getErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "Tool execution failed.";
const runMigratedTool = async ({
	input,
	name,
	options,
}: {
	input: unknown;
	name: RuntimeCodingToolName;
	options: {
		allowExternalPath: boolean;
		resourceLimits?: ToolResourceLimits;
		signal?: AbortSignal;
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
		return { errorText: getErrorMessage(error), type: "failure" };
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
	parentTurnId?: string;
};

/**
 * The application Tool Gate plus its resource-profile resolver, supplied
 * together so every runtime-armed Tool is executable only through the Gate.
 */
export type RuntimeGatedTooling = {
	gate: ToolGate;
	resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
	delegate?: DelegationExecutor;
	registerChildAbort?: (toolCallId: string, abort: () => void) => () => void;
	mcpSnapshot?: McpCatalogSnapshot;
	executeMcpTool?: GatedCodingToolsDeps["executeMcpTool"];
};
export type DelegationRequest = {
	readonly agent: AgentId;
	readonly parentToolCallId: string;
	readonly parentTurnId: string;
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
	if (signal === undefined) {
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
					: { errorText: getErrorMessage(error), kind: "deny" }
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
	parentTurnId: string
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
						agent: parsed.data.agent as AgentId,
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
			return { errorText: getErrorMessage(error), type: "failure" };
		}
	},
});

const createMcpTools = (
	snapshot: McpCatalogSnapshot | undefined,
	executeMcpTool: GatedCodingToolsDeps["executeMcpTool"],
	gate: ToolGate,
	agentId: AgentId | undefined
): readonly ResolvedTool[] => {
	if (snapshot === undefined || executeMcpTool === undefined) {
		return [];
	}
	return snapshot.manifest.flatMap((entry) => {
		const tool: McpSnapshotTool | undefined = snapshot.tools.get(entry.name);
		if (tool === undefined) {
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
					{ input, toolCallId }: { input: unknown; toolCallId: string },
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
}: GatedCodingToolsDeps): readonly ResolvedTool[] => {
	const codingTools = agentTools
		.filter(isRuntimeCodingToolName)
		.map((name) => ({
			definition: runtimeToolRegistry.require(name),
			execute: async (
				{ input, toolCallId }: { input: unknown; toolCallId: string },
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
				return runMigratedTool({
					input: outcome.input ?? input,
					name,
					options: {
						allowExternalPath: outcome.input !== undefined,
						...(resolveResourceLimits === undefined
							? {}
							: {
									resourceLimits: await resolveResourceLimits(agentId),
								}),
					},
				});
			},
		}));
	const tools = [
		...codingTools,
		...createMcpTools(mcpSnapshot, executeMcpTool, gate, agentId),
	];
	if (skillTool === undefined || skillExecution === undefined) {
		if (delegate !== undefined && parentTurnId !== undefined) {
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
			{ input, toolCallId }: { input: unknown; toolCallId: string },
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
						available: entry !== undefined,
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
	if (delegate !== undefined && parentTurnId !== undefined) {
		tools.push(createDelegationTool(delegate, parentTurnId));
	}
	return tools;
};

const migratedPartToolName = (
	type: string,
	toolName?: unknown
): RuntimeToolName | undefined => {
	if (type === "dynamic-tool") {
		return toolName === "delegate" || toolName === "skill"
			? toolName
			: undefined;
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

/** A terminal migrated tool part from prior conversation turns. */
export type MigratedToolCallPart = {
	input?: unknown;
	toolCallId: string;
	type: string;
} & (
	| { output: unknown; state: "output-available" }
	| { errorText: string; state: "output-error" }
);

/**
 * A migrated static tool part is runtime-eligible only in a terminal state:
 * output-available (input plus output) or output-error with safe text.
 * In-flight, approval, and denied parts keep the legacy path so no pending
 * execution is ever replayed as history.
 */
export const isMigratedToolCallPart = (
	part: unknown
): part is MigratedToolCallPart => {
	if (typeof part !== "object" || part === null || !("type" in part)) {
		return false;
	}
	const candidate = part as Record<string, unknown>;
	if (
		typeof candidate.type !== "string" ||
		migratedPartToolName(candidate.type, candidate.toolName) === undefined
	) {
		return false;
	}
	if (
		typeof candidate.toolCallId !== "string" ||
		candidate.toolCallId.length === 0
	) {
		return false;
	}
	if (candidate.state === "output-available") {
		return "output" in candidate;
	}
	if (candidate.state === "output-error") {
		return (
			typeof candidate.errorText === "string" && candidate.errorText.length > 0
		);
	}
	return false;
};

/**
 * Eligibility for the Agent Runtime path at the conversation seam. MCP and
 * non-migrated coding families remain on the legacy path; Skills are native
 * runtime tools and use the same application Tool Gate as coding tools.
 */
export const isRuntimeEligibleSend = ({
	gate,
	mcpManifest,
	messages,
	resolvedAgent,
	skillTool,
}: {
	gate?: ToolGate;
	mcpManifest: McpToolManifest;
	messages: readonly CodingAgentUIMessage[];
	resolvedAgent: ResolvedAgentRuntime | undefined;
	skill: SkillRequestContext | undefined;
	skillTool: SkillToolDefinition | undefined;
}): boolean => {
	if (!resolvedAgent) {
		return false;
	}
	for (const tool of resolvedAgent.visibleCodingTools) {
		if (!isRuntimeCodingToolName(tool)) {
			return false;
		}
	}
	if (
		(resolvedAgent.visibleCodingTools.length > 0 || skillTool !== undefined) &&
		gate === undefined
	) {
		return false;
	}
	if (mcpManifest.length > 0) {
		return false;
	}
	for (const message of messages) {
		if (!isRuntimeEligibleMessage(message)) {
			return false;
		}
	}
	return true;
};

const isRuntimeEligibleMessage = (message: CodingAgentUIMessage): boolean => {
	if (message.role !== "assistant" && message.role !== "user") {
		return false;
	}
	let hasContent = false;
	for (const part of message.parts) {
		if (part.type === "text") {
			hasContent = hasContent || part.text.length > 0;
			continue;
		}
		if (part.type === "step-start" || part.type === "reasoning") {
			continue;
		}
		if (isMigratedToolCallPart(part)) {
			if (message.role !== "assistant") {
				return false;
			}
			hasContent = true;
			continue;
		}
		// Tool parts of other coding families, MCP dynamic tools, file,
		// source, and data parts keep the send on the legacy path.
		return false;
	}
	// An assistant reply that streamed only reasoning would otherwise be
	// dropped from the runtime prompt, breaking role alternation with the
	// legacy path. Keep such conversations on the legacy path.
	return message.role !== "assistant" || hasContent;
};

type TurnToolCallPart = {
	input: unknown;
	toolCallId: string;
	toolName: RuntimeToolName;
	type: "tool-call";
};

/**
 * Converts one terminal migrated UI tool part into its Assistant tool-call
 * request plus the `tool` role message that carries the settled result.
 */
const toToolCallParts = (
	part: MigratedToolCallPart,
	name: RuntimeToolName
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
			toolCallId,
			toolName: name,
			type: "tool-failure",
		},
	};
};

const toAssistantTurnMessages = (
	message: CodingAgentUIMessage
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
		if (!isMigratedToolCallPart(part)) {
			continue;
		}
		const name = migratedPartToolName(
			part.type,
			"toolName" in part ? part.toolName : undefined
		);
		if (name === undefined) {
			continue;
		}
		const { request, result } = toToolCallParts(part, name);
		parts.push(request);
		results.push({
			id: `tool-${request.toolCallId}`,
			parts: [result],
			role: "tool",
		});
	}
	if (parts.length === 0) {
		return [];
	}
	return [{ id: message.id, parts, role: "assistant" }, ...results];
};

const toUserTurnMessages = (
	message: CodingAgentUIMessage
): AgentTurnMessage[] => {
	const textParts = message.parts.flatMap((part) =>
		part.type === "text" && part.text.length > 0
			? [{ text: part.text, type: "text" as const }]
			: []
	);
	return textParts.length === 0
		? []
		: [{ id: message.id, parts: textParts, role: "user" }];
};

const toAgentTurnMessages = (
	message: CodingAgentUIMessage
): AgentTurnMessage[] => {
	if (message.role === "user") {
		return toUserTurnMessages(message);
	}
	if (message.role === "assistant") {
		return toAssistantTurnMessages(message);
	}
	return [];
};

/**
 * Builds one Agent Turn from the resolved conversation send. The Model Target
 * is resolved by the caller (it needs authorization); the Agent instructions
 * are composed the same way the legacy loop composes them; `tools` carries
 * the gated Resolved Tools the runtime may invoke for this Agent.
 */
export const buildAgentTurn = ({
	agent,
	modelMessages,
	modelTarget,
	resolvedAgent,
	role,
	skill,
	tools = [],
	turnId,
	delegation,
}: {
	agent: AgentId;
	delegation?: AgentTurnDelegation;
	modelMessages: readonly CodingAgentUIMessage[];
	modelTarget: ModelTarget;
	resolvedAgent: ResolvedAgentRuntime;
	role?: AgentRole;
	skill?: SkillRequestContext;
	tools?: readonly ResolvedTool[];
	turnId: string;
}): AgentTurn => {
	const messages = modelMessages.flatMap(toAgentTurnMessages);
	const effectiveRole =
		delegation === undefined ? (role ?? "primary") : "subagent";
	if (skill !== undefined) {
		messages.push({
			id: "skill-context",
			parts: [{ text: formatSkillUserContext(skill), type: "text" }],
			role: "user",
		});
	}
	return {
		agent: {
			id: agent,
			instructions: getSystemInstructionsForAgent(resolvedAgent.instructions),
			role: effectiveRole,
		},
		...(delegation === undefined ? {} : { delegation }),
		id: turnId,
		input: { messages },
		model: modelTarget,
		tools,
	};
};

const normalizeTerminalEvent = (
	event: AgentTurnTerminalEvent,
	turn: AgentTurn
): AgentTurnTerminalEvent => {
	if (event.type === "agent-turn-completed") {
		return event;
	}
	return {
		...event,
		failure: normalizeOperationalFailure(event.failure, {
			modelId: turn.model.modelId,
			providerId: turn.model.providerId,
		}),
	};
};

/**
 * Application-owned durability hook: receives the Conversation Record for a
 * terminal Agent Turn Event and persists it as one semantic checkpoint. The
 * hook runs before the terminal display chunk is emitted, so the checkpoint
 * is durable before the executor observes the terminal outcome.
 */
export type CheckpointCommitter = (
	record: ConversationRecord
) => Promise<void> | void;

const durableInputMessages = (turn: AgentTurn): ConversationMessageRecord[] =>
	turn.input.messages.flatMap((message) => {
		if (message.role === "tool") {
			return [];
		}
		const parts = message.parts.flatMap((part) =>
			part.type === "text" ? [{ text: part.text, type: "text" as const }] : []
		);
		return parts.length === 0
			? []
			: [{ id: message.id, parts, role: message.role }];
	});

const toDurableToolPart = (part: {
	input: unknown;
	outcome:
		| {
				errorText: string;
				type: "failure";
		  }
		| {
				output: unknown;
				type: "success";
		  };
	sequence: number;
	toolCallId: string;
	toolName: string;
}): ConversationToolCallPart => ({
	input: part.input,
	outcome:
		part.outcome.type === "success"
			? { kind: "success", output: part.outcome.output }
			: { errorText: part.outcome.errorText, kind: "failure" },
	sequence: part.sequence,
	toolCallId: part.toolCallId,
	toolName: part.toolName,
	type: "tool-call",
});

/**
 * Builds the Conversation Record for a terminal Agent Turn Event. A turn
 * commits the resolved text input plus the assembled assistant reply: the
 * streamed text when the turn completed with text and every Tool Call that
 * reached a settled outcome, in event-sequence order. Reasoning deltas and
 * in-flight Tool Calls are never persisted.
 */
export const buildTerminalConversationRecord = ({
	assistantText,
	event,
	toolCalls,
	turn,
}: {
	assistantText: string;
	event: AgentTurnTerminalEvent;
	toolCalls: readonly {
		input: unknown;
		outcome:
			| { errorText: string; type: "failure" }
			| {
					output: unknown;
					type: "success";
			  };
		sequence: number;
		toolCallId: string;
		toolName: string;
	}[];
	turn: AgentTurn;
}): ConversationRecord => {
	const safeEvent = normalizeTerminalEvent(event, turn);
	const safeUsage =
		safeEvent.type === "agent-turn-completed"
			? (normalizeModelUsage(safeEvent.usage) ?? undefined)
			: undefined;
	const messages = durableInputMessages(turn);
	const assistantParts: ConversationToolCallPart[] =
		toolCalls.map(toDurableToolPart);
	if (safeEvent.type === "agent-turn-completed" && assistantText.length > 0) {
		messages.push({
			id: `assistant-${turn.id}`,
			parts: [{ text: assistantText, type: "text" }, ...assistantParts],
			role: "assistant",
		});
	} else if (assistantParts.length > 0) {
		messages.push({
			id: `assistant-${turn.id}`,
			parts: [...assistantParts],
			role: "assistant",
		});
	}

	let outcome: ConversationRecord["outcome"];
	switch (safeEvent.type) {
		case "agent-turn-cancelled":
			outcome = {
				failure: safeEvent.failure,
				finishedAt: safeEvent.finishedAt,
				kind: "cancelled",
			};
			break;
		case "agent-turn-completed":
			outcome = {
				finishedAt: safeEvent.finishedAt,
				kind: "completed",
				...(safeUsage === undefined ? {} : { usage: safeUsage }),
			};
			break;
		case "agent-turn-failed":
			outcome = {
				failure: safeEvent.failure,
				finishedAt: safeEvent.finishedAt,
				kind: "failed",
			};
			break;
		case "agent-turn-interrupted":
			outcome = {
				failure: safeEvent.failure,
				finishedAt: safeEvent.finishedAt,
				kind: "interrupted",
				reason: safeEvent.reason,
			};
			break;
		default:
			throw new AgentInvariantError(
				"invalid-event",
				"Agent Turn terminal outcome could not be projected.",
				{ cause: safeEvent }
			);
	}

	return {
		agentId: turn.agent.id,
		...(turn.delegation === undefined ? {} : { delegation: turn.delegation }),
		id: `record-${crypto.randomUUID()}`,
		messages,
		model: { modelId: turn.model.modelId, providerId: turn.model.providerId },
		outcome,
		turnId: turn.id,
		version: CONVERSATION_RECORD_VERSION,
	};
};
export const runAgentTurnToText = async ({
	onCheckpoint,
	onViewState,
	runtime,
	signal,
	turn,
}: {
	onCheckpoint?: CheckpointCommitter;
	onViewState?: (state: ConversationViewState) => void;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	turn: AgentTurn;
}): Promise<string> => {
	let assistantText = "";
	let terminal: AgentTurnTerminalEvent | undefined;
	let lastSequence = -1;
	const startedTools = new Map<
		string,
		{ readonly input: unknown; readonly toolName: string }
	>();
	const toolCalls = new Map<string, ConversationToolCallPart>();
	await consumeAgentTurnEvents({
		onEvent: (event) => {
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
				if (started !== undefined) {
					toolCalls.set(event.toolCallId, {
						input: started.input,
						outcome:
							event.outcome.type === "success"
								? { kind: "success", output: event.outcome.output }
								: { errorText: event.outcome.errorText, kind: "failure" },
						sequence: event.sequence,
						toolCallId: event.toolCallId,
						toolName: started.toolName,
						type: "tool-call",
					});
					startedTools.delete(event.toolCallId);
				}
			}
		},
		onTerminal: (event) => {
			lastSequence = Math.max(lastSequence, event.sequence);
			terminal = event;
		},
		onViewState,
		runtime,
		signal,
		turn,
	});
	const terminalEvent =
		terminal === undefined
			? resolveMissingTerminalEvent(signal, turn, lastSequence)
			: terminalEventForOutcome(terminal, turn, signal);
	const record = buildTerminalConversationRecord({
		assistantText,
		event: terminalEvent,
		toolCalls: [...toolCalls.values()]
			.toSorted((left, right) => left.sequence - right.sequence)
			.map(({ input, outcome, sequence, toolCallId, toolName }) => ({
				input,
				outcome:
					outcome.kind === "success"
						? { output: outcome.output, type: "success" as const }
						: { errorText: outcome.errorText, type: "failure" as const },
				sequence,
				toolCallId,
				toolName,
			})),
		turn,
	});
	try {
		await onCheckpoint?.(record);
	} catch (error) {
		if (isAgentInvariantError(error)) {
			throw error;
		}
		throw new Error(CHECKPOINT_FAILURE_MESSAGE, { cause: error });
	}
	if (terminalEvent.type === "agent-turn-completed") {
		return assistantText;
	}
	throw new Error(terminalEvent.failure.message);
};

/** Maps a terminal Agent Turn Event onto the executor display chunk. */
const terminalChunkFor = (event: AgentTurnTerminalEvent): UIMessageChunk => {
	if (event.type === "agent-turn-completed") {
		const safeUsage = normalizeModelUsage(event.usage) ?? undefined;
		return {
			finishReason: "stop",
			...(safeUsage === undefined
				? {}
				: { messageMetadata: { usage: safeUsage } }),
			type: "finish",
		};
	}
	return { errorText: event.failure.message, type: "error" };
};

const CHECKPOINT_FAILURE_MESSAGE =
	"The Agent Turn outcome could not be persisted.";

/**
 * Owns the open text/reasoning part state of one display chunk stream so a
 * terminal Agent Turn Event closes every part before the terminal chunk.
 * Part ids are unique per open session because the executor resets its
 * active part maps between Model Steps.
 */
const createPartWriter = (enqueue: (chunk: UIMessageChunk) => void) => {
	let nextTextId = 1;
	let nextReasoningId = 1;
	let reasoningOpen = false;
	let textOpen = false;

	const closeText = (): void => {
		if (!textOpen) {
			return;
		}
		textOpen = false;
		enqueue({ id: `text-${nextTextId - 1}`, type: "text-end" });
	};
	const closeReasoning = (): void => {
		if (!reasoningOpen) {
			return;
		}
		reasoningOpen = false;
		enqueue({ id: `reasoning-${nextReasoningId - 1}`, type: "reasoning-end" });
	};
	const closeParts = (): void => {
		closeText();
		closeReasoning();
	};

	const openStep = (): void => {
		enqueue({ type: "start-step" });
	};
	const textDelta = (delta: string): void => {
		if (!textOpen) {
			textOpen = true;
			enqueue({ id: `text-${nextTextId}`, type: "text-start" });
			nextTextId += 1;
		}
		enqueue({ delta, id: `text-${nextTextId - 1}`, type: "text-delta" });
	};
	const reasoningDelta = (delta: string): void => {
		if (!reasoningOpen) {
			reasoningOpen = true;
			enqueue({ id: `reasoning-${nextReasoningId}`, type: "reasoning-start" });
			nextReasoningId += 1;
		}
		enqueue({
			delta,
			id: `reasoning-${nextReasoningId - 1}`,
			type: "reasoning-delta",
		});
	};
	const finishStep = (): void => {
		closeParts();
		enqueue({ type: "finish-step" });
	};

	return { closeParts, finishStep, openStep, reasoningDelta, textDelta };
};

const resolveMissingTerminalEvent = (
	signal: AbortSignal | undefined,
	turn: AgentTurn,
	lastSequence: number
): AgentTurnTerminalEvent =>
	signal?.aborted
		? createAgentTurnAbortEvent(turn, signal, lastSequence + 1)
		: createLostExecutionEvent(turn, lastSequence + 1);

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

const terminalEventForOutcome = (
	event: AgentTurnTerminalEvent,
	turn: AgentTurn,
	outcomeSignal: AbortSignal | undefined
): AgentTurnTerminalEvent =>
	outcomeSignal?.aborted
		? createAgentTurnAbortEvent(turn, outcomeSignal, event.sequence)
		: event;
const resolveOutcomeSignal = (
	runtimeSignal: AbortSignal | undefined,
	outcomeSignal: AbortSignal | undefined
): AbortSignal | undefined => {
	if (outcomeSignal?.aborted) {
		return outcomeSignal;
	}
	if (runtimeSignal?.aborted) {
		return runtimeSignal;
	}
};

type StreamState = {
	streamedText: string;
	terminalEmitted: boolean;
	/** Committed Tool Calls in finished-event order for the terminal record. */
	toolCalls: Array<{
		input: unknown;
		outcome:
			| { errorText: string; type: "failure" }
			| {
					output: unknown;
					type: "success";
			  };
		sequence: number;
		toolCallId: string;
		toolName: string;
	}>;
};

type PartWriter = {
	closeParts: () => void;
	finishStep: () => void;
	openStep: () => void;
	reasoningDelta: (delta: string) => void;
	textDelta: (delta: string) => void;
};
type TerminalProcessor = (event: AgentTurnTerminalEvent) => Promise<void>;

const toolInputChunks = ({
	input,
	toolCallId,
	toolName,
}: {
	input: unknown;
	toolCallId: string;
	toolName: string;
}): UIMessageChunk[] => [
	{
		providerExecuted: true,
		toolCallId,
		toolName,
		type: "tool-input-start",
	},
	{
		input,
		providerExecuted: true,
		toolCallId,
		toolName,
		type: "tool-input-available",
	},
];

const createTerminalProcessor = ({
	lifecycle,
	onCheckpoint,
	outcomeSignal,
	state,
	turn,
	writer,
	enqueue,
}: {
	enqueue: (chunk: UIMessageChunk) => void;
	lifecycle: AgentTurnLifecycle;
	onCheckpoint?: CheckpointCommitter;
	outcomeSignal?: AbortSignal;
	state: StreamState;
	turn: AgentTurn;
	writer: PartWriter;
}): TerminalProcessor => {
	const emitTerminal = (chunk: UIMessageChunk): void => {
		writer.closeParts();
		state.terminalEmitted = true;
		enqueue(chunk);
	};

	return async (event: AgentTurnTerminalEvent): Promise<void> => {
		const safeEvent = normalizeTerminalEvent(
			terminalEventForOutcome(event, turn, outcomeSignal),
			turn
		);
		lifecycle.apply(safeEvent);
		if (onCheckpoint === undefined) {
			emitTerminal(terminalChunkFor(safeEvent));
			return;
		}
		try {
			await onCheckpoint(
				buildTerminalConversationRecord({
					assistantText: state.streamedText,
					event: safeEvent,
					toolCalls: state.toolCalls,
					turn,
				})
			);
			emitTerminal(terminalChunkFor(safeEvent));
		} catch (error) {
			if (isAgentInvariantError(error)) {
				throw error;
			}
			// A failed turn failed regardless of record durability, so its safe
			// failure text stays visible; only a completed turn degrades to the
			// persistence error.
			emitTerminal(
				safeEvent.type === "agent-turn-completed"
					? { errorText: CHECKPOINT_FAILURE_MESSAGE, type: "error" }
					: terminalChunkFor(safeEvent)
			);
		}
	};
};
const consumeRuntimeEvents = async ({
	enqueue,
	lifecycle,
	processTerminal,
	onViewState,
	runtime,
	signal,
	startedToolInputs,
	state,
	writer,
	turn,
}: {
	enqueue: (chunk: UIMessageChunk) => void;
	lifecycle: AgentTurnLifecycle;
	onViewState?: (state: ConversationViewState) => void;
	processTerminal: TerminalProcessor;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	startedToolInputs: Map<string, unknown>;
	state: StreamState;
	turn: AgentTurn;
	writer: PartWriter;
}): Promise<void> =>
	consumeAgentTurnEvents({
		lifecycle,
		onEvent: async (event) => {
			switch (event.type) {
				case "model-step-started":
					writer.openStep();
					break;
				case "reasoning-delta":
					writer.reasoningDelta(event.delta);
					break;
				case "text-delta":
					state.streamedText += event.delta;
					writer.textDelta(event.delta);
					break;
				case "model-step-finished":
					writer.finishStep();
					break;
				case "tool-call-started":
					startedToolInputs.set(event.toolCallId, event.input);
					for (const chunk of toolInputChunks(event)) {
						enqueue(chunk);
					}
					break;
				case "tool-call-finished":
					if (event.outcome.type === "success") {
						enqueue({
							output: event.outcome.output,
							toolCallId: event.toolCallId,
							type: "tool-output-available",
						});
					} else {
						enqueue({
							errorText: event.outcome.errorText,
							toolCallId: event.toolCallId,
							type: "tool-output-error",
						});
					}
					state.toolCalls.push({
						input: startedToolInputs.get(event.toolCallId),
						outcome: event.outcome,
						sequence: event.sequence,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
					});
					break;
				default:
					break;
			}
		},
		onTerminal: processTerminal,
		runtime,
		signal,
		onViewState,
		turn,
	});

const completeMissingTerminal = async ({
	lifecycle,
	processTerminal,
	signal,
	outcomeSignal,
	state,
	turn,
}: {
	lifecycle: AgentTurnLifecycle;
	processTerminal: TerminalProcessor;
	signal?: AbortSignal;
	outcomeSignal?: AbortSignal;
	state: StreamState;
	turn: AgentTurn;
}): Promise<void> => {
	if (state.terminalEmitted) {
		return;
	}
	const lifecycleState = lifecycle.getState();
	if (!lifecycleState.started) {
		throw new AgentInvariantError(
			"missing-terminal-outcome",
			"Agent Runtime ended before emitting an Agent Turn start.",
			{ cause: lifecycleState }
		);
	}
	const terminalSignal = resolveOutcomeSignal(signal, outcomeSignal);
	const event =
		terminalSignal === undefined
			? createLostExecutionEvent(turn, lifecycleState.lastSequence + 1)
			: createAgentTurnAbortEvent(
					turn,
					terminalSignal,
					lifecycleState.lastSequence + 1
				);
	await processTerminal(event);
};

const handleRuntimeError = async ({
	error,
	lifecycle,
	processTerminal,
	outcomeSignal,
	signal,
	state,
	turn,
}: {
	error: unknown;
	lifecycle: AgentTurnLifecycle;
	processTerminal: TerminalProcessor;
	outcomeSignal?: AbortSignal;
	signal?: AbortSignal;
	state: StreamState;
	turn: AgentTurn;
}): Promise<void> => {
	if (isAgentInvariantError(error)) {
		throw error;
	}
	if (state.terminalEmitted) {
		return;
	}
	const sequence = lifecycle.getState().lastSequence + 1;
	const terminalSignal = resolveOutcomeSignal(signal, outcomeSignal);
	const event: AgentTurnTerminalEvent = terminalSignal?.aborted
		? createAgentTurnAbortEvent(turn, terminalSignal, sequence)
		: {
				failure: normalizeOperationalFailure(error, {
					modelId: turn.model.modelId,
					providerId: turn.model.providerId,
				}),
				finishedAt: Date.now(),
				sequence,
				turnId: turn.id,
				type: "agent-turn-failed",
			};
	await processTerminal(event);
};

const runRuntimeStream = async ({
	controller,
	onCheckpoint,
	onViewState,
	outcomeSignal,
	runtime,
	signal,
	turn,
}: {
	controller: ReadableStreamDefaultController<UIMessageChunk>;
	onCheckpoint?: CheckpointCommitter;
	onViewState?: (state: ConversationViewState) => void;
	outcomeSignal?: AbortSignal;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	turn: AgentTurn;
}): Promise<void> => {
	const enqueue = (chunk: UIMessageChunk): void => {
		controller.enqueue(chunk);
	};
	const writer = createPartWriter(enqueue);
	const lifecycle = createAgentTurnLifecycle(turn.id);
	const state: StreamState = {
		streamedText: "",
		terminalEmitted: false,
		toolCalls: [],
	};
	const startedToolInputs = new Map<string, unknown>();
	const processTerminal = createTerminalProcessor({
		enqueue,
		outcomeSignal,
		lifecycle,
		onCheckpoint,
		state,
		turn,
		writer,
	});

	try {
		await consumeRuntimeEvents({
			enqueue,
			onViewState,
			lifecycle,
			processTerminal,
			runtime,
			signal,
			startedToolInputs,
			state,
			turn,
			writer,
		});
		await completeMissingTerminal({
			lifecycle,
			processTerminal,
			outcomeSignal,
			signal,
			state,
			turn,
		});
	} catch (error) {
		try {
			await handleRuntimeError({
				error,
				lifecycle,
				processTerminal,
				outcomeSignal,
				signal,
				state,
				turn,
			});
		} catch (terminalError) {
			if (isAgentInvariantError(terminalError)) {
				controller.error(terminalError);
				return;
			}
			if (!state.terminalEmitted) {
				writer.closeParts();
				state.terminalEmitted = true;
				enqueue({
					errorText: "The Agent Turn failed unexpectedly.",
					type: "error",
				});
			}
		}
	}

	if (!state.terminalEmitted) {
		writer.closeParts();
	}
	controller.close();
};

/**
 * CLI-owned adapter: runs one Agent Turn through the public Agent Runtime and
 * maps its Wincode Agent Turn Events onto the display chunk stream the
 * existing conversation executor consumes. The chunk protocol is only the
 * presentation boundary the application already owns; Agent Turn Events
 * remain the Wincode source of truth.
 */
export const createRuntimeStream = async ({
	onCheckpoint,
	onViewState,
	outcomeSignal,
	runtime,
	signal,
	turn,
}: {
	onCheckpoint?: CheckpointCommitter;
	onViewState?: (state: ConversationViewState) => void;
	outcomeSignal?: AbortSignal;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	turn: AgentTurn;
}): Promise<ReadableStream<UIMessageChunk>> =>
	new ReadableStream<UIMessageChunk>({
		start: (controller) =>
			runRuntimeStream({
				controller,
				onCheckpoint,
				onViewState,
				runtime,
				outcomeSignal,
				signal,
				turn,
			}),
	});

import {
	type AgentId,
	AgentInvariantError,
	type AgentRole,
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnDelegation,
	type AgentTurnEvent,
	type AgentTurnFilePart,
	type AgentTurnInterruptedEvent,
	type AgentTurnMessage,
	type AgentTurnOutcomeRecord,
	type AgentTurnPart,
	type AgentTurnTerminalEvent,
	agentIdSchema,
	CONVERSATION_RECORD_VERSION,
	type ConversationMessageMetadataRecord,
	type ConversationRecord,
	type ConversationToolCallPart,
	createAgentTurnAbortEvent,
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
import { z } from "zod";
import type { McpCatalogSnapshot, McpSnapshotTool } from "@/modules/mcp";
import type { ResolvedCodingAgent } from "../../agents/built-ins";
import type { GateOutcome, ToolGate } from "../../tool-gate/tool-gate";
import {
	type ConversationViewState,
	consumeAgentTurnEvents,
} from "../conversation-controller";
import type { ConversationMessage } from "../message";
import { expandConversationMessagesForModel } from "../message";
import {
	formatAttachmentUnavailableMarker,
	getAttachmentReference,
} from "../storage/attachment-store";

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
const runCodingToolThroughGate = async ({
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
				return runCodingToolThroughGate({
					input: outcome.input ?? input,
					name,
					options: {
						allowExternalPath: outcome.input !== undefined,
						...(resolveResourceLimits === undefined
							? {}
							: {
									resourceLimits: await resolveResourceLimits(agentId),
								}),
						signal,
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

const settledToolName = (
	type: string,
	toolName?: unknown
): string | undefined => {
	if (type === "dynamic-tool") {
		return typeof toolName === "string" && toolName.length > 0
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

/** A terminal tool part from prior conversation turns. */
export type SettledConversationToolCallPart = {
	input?: unknown;
	toolCallId: string;
	toolName?: string;
	type: string;
} & (
	| { output: unknown; state: "output-available" }
	| { errorText: string; state: "output-error" }
);

/** Only settled tool calls are replayed into a new Agent Turn. */
export const isSettledConversationToolCallPart = (
	part: unknown
): part is SettledConversationToolCallPart => {
	if (typeof part !== "object" || part === null || !("type" in part)) {
		return false;
	}
	const candidate = part as Record<string, unknown>;
	if (
		typeof candidate.type !== "string" ||
		settledToolName(candidate.type, candidate.toolName) === undefined
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

type TurnToolCallPart = {
	input: unknown;
	toolCallId: string;
	toolName: string;
	type: "tool-call";
};

/**
 * Converts one terminal conversation Tool part into its Assistant tool-call
 * request plus the `tool` role message that carries the settled result.
 */
const toToolCallParts = (
	part: SettledConversationToolCallPart,
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
			toolCallId,
			toolName: name,
			type: "tool-failure",
		},
	};
};

const toAssistantTurnMessages = (
	message: ConversationMessage
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
		if (!isSettledConversationToolCallPart(part)) {
			continue;
		}
		const name = settledToolName(
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

const toUserTurnPart = (
	part: ConversationMessage["parts"][number]
): AgentTurnPart | undefined => {
	if (part.type === "text") {
		return part.text.length > 0 ? { text: part.text, type: "text" } : undefined;
	}
	if (part.type !== "file") {
		return;
	}
	const reference = getAttachmentReference(part);
	if (reference !== null) {
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

const toUserTurnMessages = (
	message: ConversationMessage
): AgentTurnMessage[] => {
	const parts = message.parts.flatMap((part) => {
		const modelPart = toUserTurnPart(part);
		return modelPart === undefined ? [] : [modelPart];
	});
	return parts.length === 0 ? [] : [{ id: message.id, parts, role: "user" }];
};

const toAgentTurnMessages = (
	message: ConversationMessage
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
	tools = [],
	turnId,
	delegation,
}: {
	agent: AgentId;
	delegation?: AgentTurnDelegation;
	modelMessages: readonly ConversationMessage[];
	modelTarget: ModelTarget;
	resolvedAgent: ResolvedCodingAgent;
	role?: AgentRole;
	skill?: SkillRequestContext;
	tools?: readonly ResolvedTool[];
	turnId: string;
}): AgentTurn => {
	const messages =
		expandConversationMessagesForModel(modelMessages).flatMap(
			toAgentTurnMessages
		);
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
			instructions: `${BASE_AGENT_INSTRUCTIONS}\n\n${resolvedAgent.instructions}`,
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

const recordModelForTurn = (turn: AgentTurn): ConversationRecord["model"] => ({
	modelId: turn.model.modelId,
	providerId: turn.model.providerId,
	...(turn.model.variant === undefined ? {} : { variant: turn.model.variant }),
});
const assistantRecordMetadata = (
	turn: AgentTurn,
	usage?: NonNullable<ReturnType<typeof normalizeModelUsage>>,
	sourceUserMessageId?: string
): ConversationMessageMetadataRecord => ({
	...(sourceUserMessageId === undefined ? {} : { sourceUserMessageId }),
	model: {
		modelId: turn.model.modelId,
		providerId: turn.model.providerId,
	},
	...(turn.model.variant === undefined ? {} : { variant: turn.model.variant }),
	...(usage === undefined ? {} : { usage }),
});

/**
 * Builds one durable assistant row for a terminal Agent Turn. Tool Call rows
 * are committed separately at their completion boundaries, so a successful
 * tool-only turn intentionally returns no assistant row.
 */
export const buildTerminalConversationRecord = ({
	assistantText,
	event,
	hasCompletedToolCalls = false,
	sourceUserMessageId,
	turn,
}: {
	assistantText: string;
	event: AgentTurnTerminalEvent;
	hasCompletedToolCalls?: boolean;
	sourceUserMessageId?: string;
	turn: AgentTurn;
}): ConversationRecord | undefined => {
	const safeEvent = normalizeTerminalEvent(event, turn);
	const safeUsage =
		safeEvent.type === "agent-turn-completed"
			? (normalizeModelUsage(safeEvent.usage) ?? undefined)
			: undefined;
	const text =
		safeEvent.type === "agent-turn-completed"
			? assistantText
			: safeEvent.failure.message;
	if (
		text.length === 0 &&
		(safeEvent.type !== "agent-turn-completed" || hasCompletedToolCalls)
	) {
		return;
	}

	let terminal: AgentTurnOutcomeRecord;
	switch (safeEvent.type) {
		case "agent-turn-cancelled":
			terminal = {
				failure: safeEvent.failure,
				finishedAt: safeEvent.finishedAt,
				kind: "cancelled",
			};
			break;
		case "agent-turn-completed":
			terminal = {
				finishedAt: safeEvent.finishedAt,
				kind: "completed",
				...(safeUsage === undefined ? {} : { usage: safeUsage }),
			};
			break;
		case "agent-turn-failed":
			terminal = {
				failure: safeEvent.failure,
				finishedAt: safeEvent.finishedAt,
				kind: "failed",
			};
			break;
		case "agent-turn-interrupted":
			terminal = {
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
		messages: [
			{
				id: `assistant-${turn.id}`,
				metadata: assistantRecordMetadata(turn, safeUsage, sourceUserMessageId),
				parts: [{ text, type: "text" }],
				role: "assistant",
			},
		],
		model: recordModelForTurn(turn),
		outcome: { kind: "assistant", terminal },
		turnId: turn.id,
		version: CONVERSATION_RECORD_VERSION,
	};
};
const buildAssistantOutcomeConversationRecord = ({
	agentId,
	delegation,
	model,
	sourceUserMessageId,
	text,
	terminal,
	turnId,
	variant,
}: {
	agentId: AgentId;
	delegation?: AgentTurnDelegation;
	model: Pick<ConversationRecord["model"], "modelId" | "providerId">;
	sourceUserMessageId?: string;
	text: string;
	terminal: AgentTurnOutcomeRecord;
	turnId: string;
	variant?: ConversationRecord["model"]["variant"];
}): ConversationRecord => ({
	agentId,
	...(delegation === undefined ? {} : { delegation }),
	id: `record-${crypto.randomUUID()}`,
	messages: [
		{
			id: `assistant-${turnId}`,
			metadata: {
				agent: agentId,
				model: {
					modelId: model.modelId,
					providerId: model.providerId,
				},
				...(sourceUserMessageId === undefined ? {} : { sourceUserMessageId }),
				...(variant === undefined ? {} : { variant }),
			},
			parts: [{ text, type: "text" }],
			role: "assistant",
		},
	],
	model: {
		modelId: model.modelId,
		providerId: model.providerId,
		...(variant === undefined ? {} : { variant }),
	},
	outcome: { kind: "assistant", terminal },
	turnId,
	version: CONVERSATION_RECORD_VERSION,
});

export const buildAssistantFailureConversationRecord = ({
	agentId,
	delegation,
	error,
	model,
	sourceUserMessageId,
	turnId,
	variant,
}: {
	agentId: AgentId;
	delegation?: AgentTurnDelegation;
	error: unknown;
	model: Pick<ConversationRecord["model"], "modelId" | "providerId">;
	sourceUserMessageId?: string;
	turnId: string;
	variant?: ConversationRecord["model"]["variant"];
}): ConversationRecord => {
	const failure = normalizeOperationalFailure(error, {
		modelId: model.modelId,
		providerId: model.providerId,
	});
	return buildAssistantOutcomeConversationRecord({
		agentId,
		delegation,
		model,
		sourceUserMessageId,
		terminal: {
			failure,
			finishedAt: Date.now(),
			kind: "failed",
		},
		text: failure.message,
		turnId,
		variant,
	});
};

export const buildAssistantCancelledConversationRecord = ({
	agentId,
	delegation,
	model,
	sourceUserMessageId,
	turnId,
	variant,
}: {
	agentId: AgentId;
	delegation?: AgentTurnDelegation;
	model: Pick<ConversationRecord["model"], "modelId" | "providerId">;
	sourceUserMessageId?: string;
	turnId: string;
	variant?: ConversationRecord["model"]["variant"];
}): ConversationRecord => {
	const failure = createOperationalFailure({
		code: "cancelled",
		details: {
			modelId: model.modelId,
			providerId: model.providerId,
		},
		retry: "never",
		source: "runtime",
	});
	return buildAssistantOutcomeConversationRecord({
		agentId,
		delegation,
		model,
		sourceUserMessageId,
		terminal: {
			failure,
			finishedAt: Date.now(),
			kind: "cancelled",
		},
		text: failure.message,
		turnId,
		variant,
	});
};

export const buildToolConversationRecord = ({
	input,
	event,
	sourceUserMessageId,
	turn,
}: {
	event: Extract<AgentTurnEvent, { type: "tool-call-finished" }>;
	input: unknown;
	sourceUserMessageId?: string;
	turn: AgentTurn;
}): ConversationRecord => ({
	agentId: turn.agent.id,
	...(turn.delegation === undefined ? {} : { delegation: turn.delegation }),
	id: `record-${crypto.randomUUID()}`,
	messages: [
		{
			id: `tool-${turn.id}-${event.toolCallId}`,
			metadata: assistantRecordMetadata(turn, undefined, sourceUserMessageId),
			parts: [
				toDurableToolPart({
					input,
					outcome: event.outcome,
					sequence: event.sequence,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				}),
			],
			role: "assistant",
		},
	],
	model: recordModelForTurn(turn),
	outcome: { kind: "tool" },
	turnId: turn.id,
	version: CONVERSATION_RECORD_VERSION,
});
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
	signal === undefined
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
	turn,
}: {
	onCheckpoint?: CheckpointCommitter;
	onEvent?: (event: AgentTurnEvent) => void | Promise<void>;
	onTerminal?: (event: AgentTurnTerminalEvent) => void | Promise<void>;
	onToolCheckpoint?: CheckpointCommitter;
	onViewState?: (state: ConversationViewState) => void;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	sourceUserMessageId?: string;
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
		record: ConversationRecord | undefined
	): Promise<void> => {
		if (committer === undefined || record === undefined) {
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
				if (started !== undefined) {
					completedToolCalls += 1;
					await commit(
						onToolCheckpoint,
						buildToolConversationRecord({
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
		turn,
	});
	const terminalEvent = terminalEventForOutcome(
		terminal ?? resolveMissingTerminalEvent(signal, turn, lastSequence),
		turn,
		signal
	);
	const record = buildTerminalConversationRecord({
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

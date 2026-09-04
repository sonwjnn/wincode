import {
	AgentInvariantError,
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnEvent,
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
import type { SkillRequestContext, SkillToolDefinition } from "@wincode/skills";
import type { UIMessageChunk } from "ai";
import type { GateOutcome, ToolGate } from "@/modules/tool-gate/tool-gate";

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

const isRuntimeCodingToolName = (name: string): name is RuntimeCodingToolName =>
	(RUNTIME_CODING_TOOL_NAMES as readonly string[]).includes(name);

const runtimeToolDefinition = (name: RuntimeCodingToolName): ToolDefinition =>
	codingToolDefinitionFor(name);

/** The application Tool Registry of runtime-eligible coding families. */
export const runtimeToolRegistry: ToolRegistry = createToolRegistry(
	RUNTIME_CODING_TOOL_NAMES.map(runtimeToolDefinition)
);

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
	/** The tools the resolved Agent may use; deny-filtered by policy already. */
	agentTools: readonly CodingToolName[];
	gate: ToolGate;
	resolveResourceLimits?: () => Promise<ToolResourceLimits>;
};

/**
 * The application Tool Gate plus its resource-profile resolver, supplied
 * together so every runtime-armed Tool is executable only through the Gate.
 */
export type RuntimeGatedTooling = {
	gate: ToolGate;
	resolveResourceLimits?: () => Promise<ToolResourceLimits>;
};

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
	agentTools,
	gate,
	resolveResourceLimits,
}: GatedCodingToolsDeps): readonly ResolvedTool[] =>
	agentTools.filter(isRuntimeCodingToolName).map((name) => ({
		definition: runtimeToolRegistry.require(name),
		execute: async (
			{ input, toolCallId }: { input: unknown; toolCallId: string },
			{ signal }: ToolExecutorOptions = {}
		): Promise<ToolCallOutput> => {
			const outcome = await evaluateGateWithAbort(
				() =>
					gate.gate({
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
					signal,
					...(resolveResourceLimits === undefined
						? {}
						: { resourceLimits: await resolveResourceLimits() }),
				},
			});
		},
	}));

const migratedPartToolName = (
	type: string
): RuntimeCodingToolName | undefined => {
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
	type: `tool-${RuntimeCodingToolName}`;
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
	if (
		typeof part.type !== "string" ||
		migratedPartToolName(part.type) === undefined
	) {
		return false;
	}
	const candidate = part as Record<string, unknown>;
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
 * Eligibility for the Agent Runtime path at the conversation seam.
 *
 * A send runs through the runtime when the resolved Agent exposes only
 * migrated coding tools (permission filtering already hides unconditionally
 * denied tools) or no tools at all, no MCP tools are available, no Skill is
 * active, and the conversation carries only text, reasoning, step
 * boundaries, and terminal migrated Tool Call parts. Tool-armed sends need
 * the application Tool Gate for their executables; sends without one and
 * sends with non-migrated families keep the legacy agent loop byte-identical.
 */
export const isRuntimeEligibleSend = ({
	gate,
	mcpManifest,
	messages,
	resolvedAgent,
	skill,
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
	// A tool-armed Agent has no runtime route without the application Tool
	// Gate: its Resolved Tools would carry no gated executables. Such sends
	// must keep the legacy loop rather than run a stripped tool-less turn.
	if (resolvedAgent.visibleCodingTools.length > 0 && gate === undefined) {
		return false;
	}
	// A body-bearing Skill on the newest user message is injected into the
	// model input by the legacy path even without an armed Skill tool; the
	// runtime path must not silently drop it.
	if (
		mcpManifest.length > 0 ||
		skill !== undefined ||
		skillTool !== undefined
	) {
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
	toolName: RuntimeCodingToolName;
	type: "tool-call";
};

/**
 * Converts one terminal migrated UI tool part into its Assistant tool-call
 * request plus the `tool` role message that carries the settled result.
 */
const toToolCallParts = (
	part: MigratedToolCallPart,
	name: RuntimeCodingToolName
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

const toAgentTurnMessages = (
	message: CodingAgentUIMessage
): AgentTurnMessage[] => {
	if (message.role !== "assistant" && message.role !== "user") {
		return [];
	}
	if (message.role === "user") {
		const textParts = message.parts.flatMap((part) =>
			part.type === "text" && part.text.length > 0
				? [{ text: part.text, type: "text" as const }]
				: []
		);
		return textParts.length === 0
			? []
			: [{ id: message.id, parts: textParts, role: "user" }];
	}
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
		const name = migratedPartToolName(part.type);
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
	tools = [],
	turnId,
}: {
	agent: AgentId;
	modelMessages: readonly CodingAgentUIMessage[];
	modelTarget: ModelTarget;
	resolvedAgent: ResolvedAgentRuntime;
	tools?: readonly ResolvedTool[];
	turnId: string;
}): AgentTurn => {
	const messages = modelMessages.flatMap(toAgentTurnMessages);
	return {
		agent: {
			id: agent,
			instructions: getSystemInstructionsForAgent(resolvedAgent.instructions),
			role: "primary",
		},
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
		id: `record-${crypto.randomUUID()}`,
		messages,
		model: { modelId: turn.model.modelId, providerId: turn.model.providerId },
		outcome,
		turnId: turn.id,
		version: CONVERSATION_RECORD_VERSION,
	};
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

const isTerminalEventType = (
	event: AgentTurnEvent
): event is AgentTurnTerminalEvent =>
	event.type === "agent-turn-completed" ||
	event.type === "agent-turn-failed" ||
	event.type === "agent-turn-cancelled" ||
	event.type === "agent-turn-interrupted";

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
	runtime,
	signal,
	startedToolInputs,
	state,
	turn,
	writer,
}: {
	enqueue: (chunk: UIMessageChunk) => void;
	lifecycle: AgentTurnLifecycle;
	processTerminal: TerminalProcessor;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	startedToolInputs: Map<string, unknown>;
	state: StreamState;
	turn: AgentTurn;
	writer: PartWriter;
}): Promise<void> => {
	for await (const event of runtime.run(turn, { signal })) {
		const terminal = isTerminalEventType(event);
		if (signal?.aborted && !terminal && event.type !== "agent-turn-started") {
			break;
		}
		if (terminal) {
			await processTerminal(event);
			if (state.terminalEmitted) {
				break;
			}
			continue;
		}
		lifecycle.apply(event);
		switch (event.type) {
			case "agent-turn-started":
				break;
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
			case "tool-call-started": {
				startedToolInputs.set(event.toolCallId, event.input);
				for (const chunk of toolInputChunks({
					input: event.input,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
				})) {
					enqueue(chunk);
				}
				break;
			}
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
	}
};

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
	outcomeSignal,
	runtime,
	signal,
	turn,
}: {
	controller: ReadableStreamDefaultController<UIMessageChunk>;
	onCheckpoint?: CheckpointCommitter;
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
	outcomeSignal,
	runtime,
	signal,
	turn,
}: {
	onCheckpoint?: CheckpointCommitter;
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
				runtime,
				outcomeSignal,
				signal,
				turn,
			}),
	});

import {
	AgentInvariantError,
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnEvent,
	type AgentTurnInterruptedEvent,
	type AgentTurnLifecycle,
	type AgentTurnMessage,
	type AgentTurnTerminalEvent,
	CONVERSATION_RECORD_VERSION,
	type ConversationMessageRecord,
	type ConversationRecord,
	createAgentTurnAbortEvent,
	createAgentTurnLifecycle,
	createOperationalFailure,
	getAgentTurnFailureDetails,
	isAgentInvariantError,
	normalizeOperationalFailure,
} from "@wincode/agent-core";
import { createAiSdkTextOnlyAgentRuntime } from "@wincode/agent-runtime-ai-sdk";
import type {
	AgentId,
	CodingAgentUIMessage,
	McpToolManifest,
	ResolvedAgentRuntime,
} from "@wincode/ai";
import { getSystemInstructionsForAgent } from "@wincode/ai";
import type { ModelTarget } from "@wincode/ai/model-target";
import { normalizeModelUsage } from "@wincode/ai/model-usage";
import type { SkillRequestContext, SkillToolDefinition } from "@wincode/skills";
import type { UIMessageChunk } from "ai";

export type TextOnlyRuntimeFactory = () => AgentRuntime;

/** Composition-root default: the private AI SDK Agent Runtime adapter. */
export const defaultTextOnlyRuntimeFactory: TextOnlyRuntimeFactory = () =>
	createAiSdkTextOnlyAgentRuntime();

/**
 * Eligibility for the text-only Agent Runtime path at the conversation seam.
 *
 * A send is text-only when the resolved Agent exposes no coding tools
 * (permission filtering already hides unconditionally denied tools), no MCP
 * tools are available, no Skill is active, and the conversation carries no
 * tool, file, or data parts. Such a turn can never invoke a Tool, so running
 * it through the tool-less Agent Runtime instead of the legacy agent loop
 * cannot change visible behavior. Tool-armed sends keep the legacy path.
 */
export const isTextOnlyEligibleSend = ({
	mcpManifest,
	messages,
	resolvedAgent,
	skill,
	skillTool,
}: {
	mcpManifest: McpToolManifest;
	messages: readonly CodingAgentUIMessage[];
	resolvedAgent: ResolvedAgentRuntime | undefined;
	skill: SkillRequestContext | undefined;
	skillTool: SkillToolDefinition | undefined;
}): boolean => {
	if (!resolvedAgent || resolvedAgent.visibleCodingTools.length > 0) {
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
		let hasText = false;
		for (const part of message.parts) {
			if (part.type === "text") {
				hasText = hasText || part.text.length > 0;
				continue;
			}
			if (part.type !== "step-start" && part.type !== "reasoning") {
				return false;
			}
		}
		// An assistant reply that streamed only reasoning would otherwise be
		// dropped from the runtime prompt, breaking role alternation with the
		// legacy path. Keep such conversations on the legacy path.
		if (message.role === "assistant" && !hasText) {
			return false;
		}
	}
	return true;
};

const toAgentTurnMessage = (
	message: CodingAgentUIMessage
): AgentTurnMessage | undefined => {
	if (message.role !== "assistant" && message.role !== "user") {
		return;
	}
	const parts = message.parts.flatMap((part) =>
		part.type === "text" && part.text.length > 0
			? [{ text: part.text, type: "text" as const }]
			: []
	);
	if (parts.length === 0) {
		return;
	}
	return { id: message.id, parts, role: message.role };
};

/**
 * Builds one text-only Agent Turn from the resolved conversation send. The
 * Model Target is resolved by the caller (it needs authorization); the Agent
 * instructions are composed the same way the legacy loop composes them.
 */
export const buildTextOnlyAgentTurn = ({
	agent,
	modelMessages,
	modelTarget,
	resolvedAgent,
	turnId,
}: {
	agent: AgentId;
	modelMessages: readonly CodingAgentUIMessage[];
	modelTarget: ModelTarget;
	resolvedAgent: ResolvedAgentRuntime;
	turnId: string;
}): AgentTurn => {
	const messages = modelMessages
		.map(toAgentTurnMessage)
		.filter((message): message is AgentTurnMessage => message !== undefined);
	return {
		agent: {
			id: agent,
			instructions: getSystemInstructionsForAgent(resolvedAgent.instructions),
			role: "primary",
		},
		id: turnId,
		input: { messages },
		model: modelTarget,
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
export type TextOnlyCheckpointCommitter = (
	record: ConversationRecord
) => Promise<void> | void;

/**
 * Builds the Conversation Record for a terminal Agent Turn Event. A text-only
 * turn commits exactly the messages it produced: the resolved input plus the
 * assembled assistant reply when the turn completed with text. Reasoning
 * deltas are projected live but never become record parts.
 */
export const buildTerminalConversationRecord = ({
	assistantText,
	event,
	turn,
}: {
	assistantText: string;
	event: AgentTurnTerminalEvent;
	turn: AgentTurn;
}): ConversationRecord => {
	const safeEvent = normalizeTerminalEvent(event, turn);
	const safeUsage =
		safeEvent.type === "agent-turn-completed"
			? (normalizeModelUsage(safeEvent.usage) ?? undefined)
			: undefined;
	const messages: ConversationMessageRecord[] = [...turn.input.messages];
	if (safeEvent.type === "agent-turn-completed" && assistantText.length > 0) {
		messages.push({
			id: `assistant-${turn.id}`,
			parts: [{ text: assistantText, type: "text" }],
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

const TEXT_CHUNK_ID = "text-1";
const REASONING_CHUNK_ID = "reasoning-1";

/**
 * Owns the open text/reasoning part state of one display chunk stream so a
 * terminal Agent Turn Event closes every part before the terminal chunk.
 */
const createPartWriter = (enqueue: (chunk: UIMessageChunk) => void) => {
	let reasoningOpen = false;
	let textOpen = false;

	const closeText = (): void => {
		if (!textOpen) {
			return;
		}
		textOpen = false;
		enqueue({ id: TEXT_CHUNK_ID, type: "text-end" });
	};
	const closeReasoning = (): void => {
		if (!reasoningOpen) {
			return;
		}
		reasoningOpen = false;
		enqueue({ id: REASONING_CHUNK_ID, type: "reasoning-end" });
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
			enqueue({ id: TEXT_CHUNK_ID, type: "text-start" });
		}
		enqueue({ delta, id: TEXT_CHUNK_ID, type: "text-delta" });
	};
	const reasoningDelta = (delta: string): void => {
		if (!reasoningOpen) {
			reasoningOpen = true;
			enqueue({ id: REASONING_CHUNK_ID, type: "reasoning-start" });
		}
		enqueue({ delta, id: REASONING_CHUNK_ID, type: "reasoning-delta" });
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

type TextOnlyStreamState = {
	streamedText: string;
	terminalEmitted: boolean;
};

type TextOnlyPartWriter = {
	closeParts: () => void;
	finishStep: () => void;
	openStep: () => void;
	reasoningDelta: (delta: string) => void;
	textDelta: (delta: string) => void;
};
type TextOnlyTerminalProcessor = (
	event: AgentTurnTerminalEvent
) => Promise<void>;

const isTerminalEventType = (
	event: AgentTurnEvent
): event is AgentTurnTerminalEvent =>
	event.type === "agent-turn-completed" ||
	event.type === "agent-turn-failed" ||
	event.type === "agent-turn-cancelled" ||
	event.type === "agent-turn-interrupted";
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
	onCheckpoint?: TextOnlyCheckpointCommitter;
	outcomeSignal?: AbortSignal;
	state: TextOnlyStreamState;
	turn: AgentTurn;
	writer: TextOnlyPartWriter;
}): TextOnlyTerminalProcessor => {
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

const consumeTextOnlyRuntimeEvents = async ({
	lifecycle,
	processTerminal,
	runtime,
	signal,
	state,
	turn,
	writer,
}: {
	lifecycle: AgentTurnLifecycle;
	processTerminal: TextOnlyTerminalProcessor;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	state: TextOnlyStreamState;
	turn: AgentTurn;
	writer: TextOnlyPartWriter;
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
			default:
				break;
		}
	}
};

const completeMissingTextOnlyTerminal = async ({
	lifecycle,
	processTerminal,
	signal,
	outcomeSignal,
	state,
	turn,
}: {
	lifecycle: AgentTurnLifecycle;
	processTerminal: TextOnlyTerminalProcessor;
	signal?: AbortSignal;
	outcomeSignal?: AbortSignal;
	state: TextOnlyStreamState;
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

const handleTextOnlyRuntimeError = async ({
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
	processTerminal: TextOnlyTerminalProcessor;
	outcomeSignal?: AbortSignal;
	signal?: AbortSignal;
	state: TextOnlyStreamState;
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

const runTextOnlyRuntimeStream = async ({
	controller,
	onCheckpoint,
	outcomeSignal,
	runtime,
	signal,
	turn,
}: {
	controller: ReadableStreamDefaultController<UIMessageChunk>;
	onCheckpoint?: TextOnlyCheckpointCommitter;
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
	const state: TextOnlyStreamState = {
		streamedText: "",
		terminalEmitted: false,
	};
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
		await consumeTextOnlyRuntimeEvents({
			lifecycle,
			processTerminal,
			runtime,
			signal,
			state,
			turn,
			writer,
		});
		await completeMissingTextOnlyTerminal({
			lifecycle,
			processTerminal,
			outcomeSignal,
			signal,
			state,
			turn,
		});
	} catch (error) {
		try {
			await handleTextOnlyRuntimeError({
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
 * CLI-owned adapter: runs one text-only Agent Turn through the public Agent
 * Runtime and maps its Wincode Agent Turn Events onto the display chunk
 * stream the existing conversation executor consumes. The chunk protocol is
 * only the presentation boundary the application already owns; Agent Turn
 * Events remain the Wincode source of truth.
 */
export const createTextOnlyRuntimeStream = async ({
	onCheckpoint,
	outcomeSignal,
	runtime,
	signal,
	turn,
}: {
	onCheckpoint?: TextOnlyCheckpointCommitter;
	outcomeSignal?: AbortSignal;
	runtime: AgentRuntime;
	signal?: AbortSignal;
	turn: AgentTurn;
}): Promise<ReadableStream<UIMessageChunk>> =>
	new ReadableStream<UIMessageChunk>({
		start: (controller) =>
			runTextOnlyRuntimeStream({
				controller,
				onCheckpoint,
				runtime,
				outcomeSignal,
				signal,
				turn,
			}),
	});

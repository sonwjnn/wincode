import type {
	AgentId,
	AgentTurnEvent,
	AgentTurnTerminalEvent,
	SessionMessageId,
	ToolCallId,
} from "@wincode/agent-core";
import type { ModelUsage } from "@wincode/ai/model-usage";
import { normalizeModelUsage } from "@wincode/ai/model-usage";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { defaultChatModelSelection } from "@wincode/ai/models";
import { isNull, isUndefined, omitUndefined } from "@wincode/runtime-utils";
import { type CodingToolName, codingToolNames } from "@/modules/tools";
import {
	isSessionToolPart,
	isTerminalSessionToolPart,
	type SessionMessage,
	type SessionMessageMetadata,
	type SessionMessageTerminalOutcome,
	type SessionToolPart,
	sanitizeInterruptedSessionMessages,
} from "../message";
import type { SessionExecution } from "./types";

const INTERRUPTED_TOOL_ERROR = "Tool call interrupted";

/** The assistant Session Message an execution streams into, before its first event. */
const createEmptyRuntimeAssistantMessage = (
	assistantId: SessionMessageId,
	sourceUserMessageId: SessionMessageId | null,
	agent: AgentId,
	model: ChatModelSelection
): SessionMessage => ({
	id: assistantId,
	metadata: {
		agent,
		model,
		...omitUndefined({ sourceUserMessageId: sourceUserMessageId ?? undefined }),
	},
	parts: [],
	role: "assistant",
});

const emptyAssistantMessageFor = (
	execution: SessionExecution
): SessionMessage =>
	createEmptyRuntimeAssistantMessage(
		execution.assistantId,
		execution.sourceUserMessageId,
		execution.agent,
		execution.model
	);

const replaceMessage = (
	messages: readonly SessionMessage[],
	message: SessionMessage
): SessionMessage[] => {
	const index = messages.findIndex(({ id }) => id === message.id);
	return index === -1
		? [...messages, message]
		: messages.map((existing, messageIndex) =>
				messageIndex === index ? message : existing
			);
};

const isCodingToolName = (name: string): name is CodingToolName =>
	codingToolNames.some((candidate) => candidate === name);

const runtimeToolPart = (
	event: Extract<AgentTurnEvent, { type: "tool-call-started" }>
): SessionToolPart => {
	if (isCodingToolName(event.toolName)) {
		return {
			input: event.input,
			state: "input-available",
			toolCallId: event.toolCallId,
			type: `tool-${event.toolName}`,
		};
	}
	return {
		input: event.input,
		state: "input-available",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		type: "dynamic-tool",
	};
};

type RuntimeToolFinishedEvent = Extract<
	AgentTurnEvent,
	{ type: "tool-call-finished" }
>;

const settleRuntimeToolPart = (
	part: SessionToolPart,
	event: RuntimeToolFinishedEvent
): SessionToolPart =>
	event.outcome.type === "success"
		? {
				...part,
				output: event.outcome.output,
				state: "output-available",
			}
		: {
				...part,
				errorText: event.outcome.errorText,
				...omitUndefined({ failure: event.outcome.failure }),
				state: "output-error",
			};

const runtimeToolResultPart = (
	event: RuntimeToolFinishedEvent
): SessionToolPart =>
	event.outcome.type === "success"
		? {
				input: undefined,
				output: event.outcome.output,
				state: "output-available",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				type: "dynamic-tool",
			}
		: {
				errorText: event.outcome.errorText,
				...omitUndefined({ failure: event.outcome.failure }),
				state: "output-error",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				type: "dynamic-tool",
			};

/**
 * The Session Context one non-terminal Agent Turn event produces: the
 * execution's assistant message is appended by id and its parts grow in event
 * order. An event the message does not present leaves the context alone.
 */
export const projectAgentTurnEvent = (
	messages: readonly SessionMessage[],
	execution: SessionExecution,
	event: AgentTurnEvent
):
	| { readonly message: SessionMessage; readonly messages: SessionMessage[] }
	| undefined => {
	const index = messages.findIndex(({ id }) => id === execution.assistantId);
	const existing =
		index === -1
			? emptyAssistantMessageFor(execution)
			: (messages[index] ?? emptyAssistantMessageFor(execution));
	const parts = [...existing.parts];
	switch (event.type) {
		case "model-step-started":
			parts.push({ type: "step-start" });
			break;
		case "reasoning-delta": {
			const last = parts.at(-1);
			if (last?.type === "reasoning") {
				parts[parts.length - 1] = {
					...last,
					text: last.text + event.delta,
				};
			} else {
				parts.push({ text: event.delta, type: "reasoning" });
			}
			break;
		}
		case "text-delta": {
			const last = parts.at(-1);
			if (last?.type === "text") {
				parts[parts.length - 1] = {
					...last,
					text: last.text + event.delta,
				};
			} else {
				parts.push({ text: event.delta, type: "text" });
			}
			break;
		}
		case "tool-call-started":
			parts.push(runtimeToolPart(event));
			break;
		case "tool-call-finished": {
			const partIndex = parts.findLastIndex(
				(part) =>
					isSessionToolPart(part) && part.toolCallId === event.toolCallId
			);
			const existingPart = parts[partIndex];
			if (
				partIndex === -1 ||
				isUndefined(existingPart) ||
				!isSessionToolPart(existingPart)
			) {
				parts.push(runtimeToolResultPart(event));
			} else {
				parts[partIndex] = settleRuntimeToolPart(existingPart, event);
			}
			break;
		}
		default:
			return;
	}
	const projected = { ...existing, parts };
	return { message: projected, messages: replaceMessage(messages, projected) };
};

const terminalOutcomeForEvent = (
	event: AgentTurnTerminalEvent
): SessionMessageTerminalOutcome | undefined => {
	if (event.type === "agent-turn-completed") {
		return;
	}
	if (event.type === "agent-turn-cancelled") {
		return "cancelled";
	}
	if (event.type === "agent-turn-failed") {
		return "failed";
	}
	return "interrupted";
};

const buildTerminalMessageMetadata = ({
	agent,
	base,
	event,
	model,
	startedAt,
	usage,
	variant,
}: {
	agent: AgentId;
	base: SessionMessage;
	event: AgentTurnTerminalEvent;
	model?: ChatModelSelection;
	startedAt: number | null;
	usage: ModelUsage | null;
	variant?: ModelVariant;
}): SessionMessageMetadata => {
	const terminalOutcome = terminalOutcomeForEvent(event);
	return {
		...(base.metadata ?? {}),
		agent: base.metadata?.agent ?? agent,
		interrupted: event.type === "agent-turn-interrupted",
		...omitUndefined({
			terminalOutcome,
			usage: usage ?? undefined,
			model: isUndefined(model) ? undefined : (base.metadata?.model ?? model),
			variant: isUndefined(variant)
				? undefined
				: (base.metadata?.variant ?? variant),
			responseTimeMs: isNull(startedAt)
				? undefined
				: Math.max(0, Date.now() - startedAt),
		}),
	};
};

const sanitizeFailedRuntimeMessages = (
	messages: readonly SessionMessage[],
	assistantId: SessionMessageId,
	failureText: string
): SessionMessage[] =>
	messages.map((message) => {
		if (message.id !== assistantId || message.role !== "assistant") {
			return message;
		}
		const terminalToolParts = message.parts.filter(
			(part): part is SessionToolPart =>
				isSessionToolPart(part) && isTerminalSessionToolPart(part)
		);
		return {
			...message,
			parts: [{ text: failureText, type: "text" }, ...terminalToolParts],
		};
	});

const sanitizeRuntimeMessagesForTerminal = (
	messages: readonly SessionMessage[],
	assistantId: SessionMessageId,
	event: AgentTurnTerminalEvent
): SessionMessage[] => {
	if (event.type === "agent-turn-completed") {
		return [...messages];
	}
	if (event.type === "agent-turn-interrupted") {
		return sanitizeInterruptedSessionMessages(messages);
	}
	return sanitizeFailedRuntimeMessages(
		messages,
		assistantId,
		event.failure.message
	);
};

/**
 * The Session Context one terminal Agent Turn event produces: the execution's
 * assistant message carries its terminal metadata, and a failed, cancelled, or
 * interrupted turn keeps only safe output.
 */
export const projectAgentTurnTerminal = (
	messages: readonly SessionMessage[],
	execution: SessionExecution,
	event: AgentTurnTerminalEvent
): SessionMessage[] => {
	const index = messages.findIndex(({ id }) => id === execution.assistantId);
	const base =
		index === -1 ? emptyAssistantMessageFor(execution) : messages[index];
	if (isUndefined(base)) {
		return [...messages];
	}
	const usage =
		event.type === "agent-turn-completed"
			? normalizeModelUsage(event.usage)
			: null;
	const metadata = buildTerminalMessageMetadata({
		agent: execution.agent,
		base,
		event,
		model: execution.model,
		startedAt: execution.startedAt,
		usage,
		variant: execution.variant,
	});
	return sanitizeRuntimeMessagesForTerminal(
		replaceMessage(messages, { ...base, metadata }),
		execution.assistantId,
		event
	);
};

/**
 * The Session Context message the current Agent Turn's output belongs to. The
 * turn's boundary is the message that opened it: a Steering Message delivered
 * mid-turn sits after that output without opening anything, so it never takes
 * the place the interruption belongs to.
 */
const findCurrentTurnAssistantIndex = (
	messages: readonly SessionMessage[]
): number => {
	const userIndex = messages.findLastIndex(
		({ metadata, role }) =>
			role === "user" && isUndefined(metadata?.joinedTurnId)
	);
	const assistantIndex = messages.findLastIndex(
		({ role }) => role === "assistant"
	);
	return assistantIndex > userIndex ? assistantIndex : -1;
};

const preserveInterruptedToolCall = (
	message: SessionMessage,
	toolCallId: ToolCallId
): SessionMessage => {
	if (message.role !== "assistant" || message.metadata?.interrupted !== true) {
		return message;
	}
	return {
		...message,
		parts: message.parts.map((part) =>
			isSessionToolPart(part) &&
			part.toolCallId === toolCallId &&
			part.state === "input-available"
				? {
						...part,
						errorText: INTERRUPTED_TOOL_ERROR,
						state: "output-error" as const,
					}
				: part
		),
	};
};

const sanitizeInterruptedMessagesForSession = (
	messages: SessionMessage[],
	preserveToolCallId?: ToolCallId
): SessionMessage[] =>
	sanitizeInterruptedSessionMessages(
		messages.map((message) =>
			isUndefined(preserveToolCallId)
				? message
				: preserveInterruptedToolCall(message, preserveToolCallId)
		),
		preserveToolCallId
	);

const findCurrentTurnInterruptTargetIndex = (
	messages: readonly SessionMessage[]
): number => {
	const assistantIndex = findCurrentTurnAssistantIndex(messages);
	return assistantIndex === -1
		? messages.findLastIndex(
				({ metadata, role }) =>
					role === "user" && isUndefined(metadata?.joinedTurnId)
			)
		: assistantIndex;
};

const finalizeAssistantMessageMetadata = (
	message: SessionMessage,
	context: {
		agent?: AgentId;
		model?: ChatModelSelection;
		variant?: ModelVariant;
		interrupted: boolean;
		responseTimeMs?: number;
	}
): SessionMessage => {
	const agent = message.metadata?.agent ?? context.agent;
	const model = message.metadata?.model ?? context.model;
	const variant = message.metadata?.variant ?? context.variant;
	const metadata: SessionMessageMetadata = {
		...(message.metadata ?? {}),
		...omitUndefined({
			agent,
			model,
			variant,
			responseTimeMs: context.responseTimeMs,
		}),
		interrupted: context.interrupted,
	};
	return { ...message, metadata };
};

/**
 * The Session Context an interrupt produces: the turn's target message is
 * finalized as interrupted and the context is sanitized, keeping the
 * interrupted Tool Call the abort named.
 */
export const interruptSessionContext = (
	messages: readonly SessionMessage[],
	execution: SessionExecution | undefined,
	preserveToolCallId?: ToolCallId
): SessionMessage[] | undefined => {
	const targetIndex = findCurrentTurnInterruptTargetIndex(messages);
	if (targetIndex === -1) {
		return;
	}
	const target = messages[targetIndex];
	if (isUndefined(target)) {
		return;
	}
	const finalized = finalizeAssistantMessageMetadata(target, {
		interrupted: true,
		...(isUndefined(execution)
			? { model: defaultChatModelSelection }
			: {
					agent: execution.agent,
					model: execution.model,
					responseTimeMs: Math.max(0, Date.now() - execution.startedAt),
					...omitUndefined({ variant: execution.variant }),
				}),
	});
	const next = [...messages];
	next[targetIndex] = finalized;
	return sanitizeInterruptedMessagesForSession(next, preserveToolCallId);
};

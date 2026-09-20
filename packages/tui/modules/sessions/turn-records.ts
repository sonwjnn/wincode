import {
	type AgentId,
	AgentInvariantError,
	type AgentTurn,
	type AgentTurnDelegation,
	type AgentTurnEvent,
	type AgentTurnId,
	type AgentTurnOutcomeRecord,
	type AgentTurnTerminalEvent,
	createOperationalFailure,
	normalizeOperationalFailure,
	SESSION_RECORD_VERSION,
	type SessionMessageId,
	type SessionMessageMetadataRecord,
	type SessionRecord,
	type SessionToolCallPart,
	type ToolCallId,
	type ToolFailureDetails,
	toSessionMessageId,
	toSessionRecordId,
} from "@wincode/agent-core";
import { normalizeModelUsage } from "@wincode/ai/model-usage";
import { omitUndefined } from "@wincode/runtime-utils";
import { randomUUIDv7 } from "bun";
import { RetiredModelError } from "../model-target";

/**
 * Durable Session Record synthesis for one Agent Turn: the assistant row a
 * terminal Agent Turn Event produces, the safe assistant rows a failed or
 * cancelled turn produces, and the tool row each completed Tool Call produces.
 * The Session Engine and the Agent Runtime consumer both write through these,
 * so the durable shape of a turn is defined once.
 */

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

const toDurableToolPart = (part: {
	input: unknown;
	outcome:
		| {
				errorText: string;
				failure?: ToolFailureDetails;
				type: "failure";
		  }
		| {
				output: unknown;
				type: "success";
		  };
	sequence: number;
	toolCallId: ToolCallId;
	toolName: string;
}): SessionToolCallPart => ({
	input: part.input,
	outcome:
		part.outcome.type === "success"
			? { kind: "success", output: part.outcome.output }
			: {
					errorText: part.outcome.errorText,
					...omitUndefined({ failure: part.outcome.failure }),
					kind: "failure",
				},
	sequence: part.sequence,
	toolCallId: part.toolCallId,
	toolName: part.toolName,
	type: "tool-call",
});

const recordModelForTurn = (turn: AgentTurn): SessionRecord["model"] => ({
	modelId: turn.model.modelId,
	providerId: turn.model.providerId,
	...omitUndefined({ variant: turn.model.variant }),
});
const assistantRecordMetadata = (
	turn: AgentTurn,
	usage?: NonNullable<ReturnType<typeof normalizeModelUsage>>,
	sourceUserMessageId?: SessionMessageId
): SessionMessageMetadataRecord => ({
	...omitUndefined({
		sourceUserMessageId,
		variant: turn.model.variant,
		usage,
	}),
	model: {
		modelId: turn.model.modelId,
		providerId: turn.model.providerId,
	},
});

/**
 * Builds one durable assistant row for a terminal Agent Turn. Tool Call rows
 * are committed separately at their completion boundaries, so a successful
 * tool-only turn intentionally returns no assistant row.
 */
export const buildTerminalSessionRecord = ({
	assistantText,
	event,
	hasCompletedToolCalls = false,
	sourceUserMessageId,
	turn,
}: {
	assistantText: string;
	event: AgentTurnTerminalEvent;
	hasCompletedToolCalls?: boolean;
	sourceUserMessageId?: SessionMessageId;
	turn: AgentTurn;
}): SessionRecord | undefined => {
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
				...omitUndefined({ usage: safeUsage }),
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
		...omitUndefined({ delegation: turn.delegation }),
		id: toSessionRecordId(`record-${randomUUIDv7()}`),
		messages: [
			{
				id: toSessionMessageId(`assistant-${turn.id}`),
				metadata: assistantRecordMetadata(turn, safeUsage, sourceUserMessageId),
				parts: [{ text, type: "text" }],
				role: "assistant",
			},
		],
		model: recordModelForTurn(turn),
		outcome: { kind: "assistant", terminal },
		turnId: turn.id,
		version: SESSION_RECORD_VERSION,
	};
};
const buildAssistantOutcomeSessionRecord = ({
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
	model: Pick<SessionRecord["model"], "modelId" | "providerId">;
	sourceUserMessageId?: SessionMessageId;
	text: string;
	terminal: AgentTurnOutcomeRecord;
	turnId: AgentTurnId;
	variant?: SessionRecord["model"]["variant"];
}): SessionRecord => ({
	agentId,
	...omitUndefined({ delegation }),
	id: toSessionRecordId(`record-${randomUUIDv7()}`),
	messages: [
		{
			id: toSessionMessageId(`assistant-${turnId}`),
			metadata: {
				agent: agentId,
				model: {
					modelId: model.modelId,
					providerId: model.providerId,
				},
				...omitUndefined({ sourceUserMessageId, variant }),
			},
			parts: [{ text, type: "text" }],
			role: "assistant",
		},
	],
	model: {
		modelId: model.modelId,
		providerId: model.providerId,
		...omitUndefined({ variant }),
	},
	outcome: { kind: "assistant", terminal },
	turnId,
	version: SESSION_RECORD_VERSION,
});

export const buildAssistantFailureSessionRecord = ({
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
	model: Pick<SessionRecord["model"], "modelId" | "providerId">;
	sourceUserMessageId?: SessionMessageId;
	turnId: AgentTurnId;
	variant?: SessionRecord["model"]["variant"];
}): SessionRecord => {
	const failure = normalizeOperationalFailure(error, {
		modelId: model.modelId,
		providerId: model.providerId,
	});
	const failureText =
		error instanceof RetiredModelError ? error.message : failure.message;
	return buildAssistantOutcomeSessionRecord({
		agentId,
		delegation,
		model,
		sourceUserMessageId,
		terminal: {
			failure,
			finishedAt: Date.now(),
			kind: "failed",
		},
		text: failureText,
		turnId,
		variant,
	});
};

export const buildAssistantCancelledSessionRecord = ({
	agentId,
	delegation,
	model,
	sourceUserMessageId,
	turnId,
	variant,
}: {
	agentId: AgentId;
	delegation?: AgentTurnDelegation;
	model: Pick<SessionRecord["model"], "modelId" | "providerId">;
	sourceUserMessageId?: SessionMessageId;
	turnId: AgentTurnId;
	variant?: SessionRecord["model"]["variant"];
}): SessionRecord => {
	const failure = createOperationalFailure({
		code: "cancelled",
		details: {
			modelId: model.modelId,
			providerId: model.providerId,
		},
		retry: "never",
		source: "runtime",
	});
	return buildAssistantOutcomeSessionRecord({
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

export const buildToolSessionRecord = ({
	input,
	event,
	sourceUserMessageId,
	turn,
}: {
	event: Extract<AgentTurnEvent, { type: "tool-call-finished" }>;
	input: unknown;
	sourceUserMessageId?: SessionMessageId;
	turn: AgentTurn;
}): SessionRecord => ({
	agentId: turn.agent.id,
	...omitUndefined({ delegation: turn.delegation }),
	id: toSessionRecordId(`record-${randomUUIDv7()}`),
	messages: [
		{
			id: toSessionMessageId(`tool-${turn.id}-${event.toolCallId}`),
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
	version: SESSION_RECORD_VERSION,
});

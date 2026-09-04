import type { ModelUsage } from "@wincode/ai/model-usage";
import type { OperationalFailure } from "./failures";
import type {
	AgentTurnDelegation,
	AgentTurnId,
	AgentTurnInterruptionReason,
	AgentTurnTextPart,
} from "./turn";

export const CONVERSATION_RECORD_VERSION = 1 as const;

/** Durable outcome of one committed Tool Call. */
export type ToolCallOutcomeRecord =
	| {
			readonly kind: "success";
			readonly output: unknown;
	  }
	| {
			readonly errorText: string;
			readonly kind: "failure";
	  };

/**
 * One committed Tool Call part of an assistant message: the request input,
 * the settled outcome, and the Agent Turn event sequence of the outcome so
 * consumers can order durable content against the transient event stream.
 */
export type ConversationToolCallPart = {
	readonly input: unknown;
	readonly outcome: ToolCallOutcomeRecord;
	readonly sequence: number;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly type: "tool-call";
};

export type ConversationMessagePart =
	| AgentTurnTextPart
	| ConversationToolCallPart;

/**
 * Wincode-owned durable Conversation content: committed text and Tool Call
 * parts. Skill metadata and Attachment References extend it with later
 * tracer slices. AI SDK part shapes never appear here.
 */
export type ConversationMessageRecord = {
	readonly id: string;
	readonly parts: readonly ConversationMessagePart[];
	readonly role: "assistant" | "user";
};

/**
 * Durable semantic outcome of one Agent Turn. Every non-completed outcome
 * carries a safe Operational Failure ticket; interruption records why the
 * execution stopped without pretending a provider stream can be resumed.
 */
export type AgentTurnOutcomeRecord =
	| {
			readonly finishedAt: number;
			readonly kind: "completed";
			readonly usage?: ModelUsage;
	  }
	| {
			readonly failure: OperationalFailure;
			readonly finishedAt: number;
			readonly kind: "failed";
	  }
	| {
			readonly failure: OperationalFailure;
			readonly finishedAt: number;
			readonly kind: "cancelled";
	  }
	| {
			readonly failure: OperationalFailure;
			readonly finishedAt: number;
			readonly kind: "interrupted";
			readonly reason: AgentTurnInterruptionReason;
	  };

/**
 * The durable Conversation Record for one completed, failed, cancelled, or
 * interrupted Agent Turn: committed message records plus model and outcome.
 * Token deltas and other incomplete Agent Turn Events are not persisted.
 */
export type ConversationRecord = {
	readonly agentId: string;
	readonly delegation?: AgentTurnDelegation;
	readonly id: string;
	readonly messages: readonly ConversationMessageRecord[];
	readonly model: {
		readonly modelId: string;
		readonly providerId: string;
	};
	readonly outcome: AgentTurnOutcomeRecord;
	readonly turnId: AgentTurnId;
	readonly version: typeof CONVERSATION_RECORD_VERSION;
};

export const isAgentTurnMessageRecord = (
	record: unknown
): record is ConversationMessageRecord => {
	if (typeof record !== "object" || record === null) {
		return false;
	}
	const value = record as Record<string, unknown>;
	return (
		Object.keys(value).every(
			(key) => key === "id" || key === "parts" || key === "role"
		) &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		(value.role === "assistant" || value.role === "user") &&
		Array.isArray(value.parts)
	);
};

import type { ModelUsage } from "@wincode/ai/model-usage";
import type { OperationalFailure } from "./failures";
import type { AgentTurnId, AgentTurnTextPart } from "./turn";

export const CONVERSATION_RECORD_VERSION = 1 as const;

/**
 * Wincode-owned durable Conversation content. This is the text-only edition of
 * the record schema; tool parts, Skill metadata, and Attachment References
 * extend it with later tracer slices. AI SDK part shapes never appear here.
 */
export type ConversationMessageRecord = {
	readonly id: string;
	readonly parts: readonly AgentTurnTextPart[];
	readonly role: "assistant" | "user";
};

/**
 * Durable semantic outcome of one Agent Turn. Interruption and cancellation
 * outcomes arrive with the operational failure ticket.
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
	  };

/**
 * The durable Conversation Record for one completed or failed Agent Turn:
 * committed message records plus the model, usage, and terminal outcome.
 * Token deltas and other incomplete Agent Turn Events are not persisted.
 */
export type ConversationRecord = {
	readonly agentId: string;
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
): record is ConversationMessageRecord =>
	typeof record === "object" &&
	record !== null &&
	typeof (record as ConversationMessageRecord).id === "string" &&
	((record as ConversationMessageRecord).role === "user" ||
		(record as ConversationMessageRecord).role === "assistant") &&
	Array.isArray((record as ConversationMessageRecord).parts);

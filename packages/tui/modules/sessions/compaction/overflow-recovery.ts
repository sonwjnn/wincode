import {
	isOperationalFailure,
	type SessionMessageId,
} from "@wincode/agent-core";
import { isModelContextOverflowError } from "@wincode/ai/model-failures";
import type { SessionMessage } from "../message";
import { sanitizeInterruptedSessionMessages } from "../message";

export class OverflowRecoveryError extends Error {
	readonly code: "replay-failed" | "replay-refused";

	constructor(
		code: OverflowRecoveryError["code"],
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.code = code;
		this.name = "OverflowRecoveryError";
	}
}

/**
 * Whether a provider refusal ended an Agent Turn because the Session Context
 * was too large. A failure that reached the session as an Operational Failure
 * carries its own code; a failure that is still the provider's error is
 * classified by the Model Failure normalization.
 */
export const isContextOverflowFailure = (error: unknown): boolean =>
	isModelContextOverflowError(error) ||
	(isOperationalFailure(error) && error.code === "context-overflow");

/**
 * The messages one overflow recovery compacts: the Session Transcript up to and
 * including the original user message, with the interrupted turn that followed
 * it sanitized away, so the replay runs the message again on a context the
 * provider accepts.
 */
export const prepareOverflowReplayMessages = (
	messages: readonly SessionMessage[],
	originalMessageId: SessionMessageId
): SessionMessage[] => {
	const originalIndex = messages.findIndex(
		(message) => message.id === originalMessageId && message.role === "user"
	);
	if (originalIndex === -1) {
		throw new OverflowRecoveryError(
			"replay-failed",
			"Context overflow recovery could not find the original user message."
		);
	}
	return sanitizeInterruptedSessionMessages([
		...messages.slice(0, originalIndex + 1),
	]);
};

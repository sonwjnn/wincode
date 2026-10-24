import {
	isOperationalFailure,
	type SessionMessageId,
} from "@wincode/agent-core";
import { isModelContextOverflowError } from "@wincode/ai";
import type { SessionMessage, SessionToolPart } from "../message";
import {
	isSessionToolPart,
	isTerminalSessionToolPart,
	sanitizeInterruptedSessionMessages,
} from "../message";

export class OverflowRecoveryError extends Error {
	readonly code: "continuation-failed" | "continuation-refused";

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
 * it sanitized away. The resulting Session Context can continue from that
 * original message without appending it again.
 */
export const prepareOverflowRecoveryMessages = (
	messages: readonly SessionMessage[],
	originalMessageId: SessionMessageId
): SessionMessage[] => {
	const originalIndex = messages.findIndex(
		(message) => message.id === originalMessageId && message.role === "user"
	);
	if (originalIndex === -1) {
		throw new OverflowRecoveryError(
			"continuation-failed",
			"Context overflow recovery could not find the original user message."
		);
	}
	return sanitizeInterruptedSessionMessages([
		...messages.slice(0, originalIndex + 1),
	]);
};

export type OverflowContinuationSource = Readonly<{
	/** The newest settled step and everything after it, never summarized. */
	protectedMessageIds: readonly SessionMessageId[];
	/** Durable history to compact, including the failed attempt's completed work. */
	sourceMessages: SessionMessage[];
}>;

const isTerminalRow = (message: SessionMessage): boolean =>
	message.role === "assistant" &&
	message.metadata?.terminalOutcome !== undefined;

const hasCompletedTool = (message: SessionMessage): boolean =>
	message.parts.some(
		(part): part is SessionToolPart =>
			isSessionToolPart(part) && isTerminalSessionToolPart(part)
	);

/**
 * Prepares recovery that must not replay completed Tool Calls. The failed
 * attempt's terminal row is dropped, older durable history is summarized, and
 * the newest settled assistant/tool batch stays intact so the compacted
 * Context can continue the turn instead of answering the prompt again.
 */
export const prepareOverflowContinuationSource = (
	messages: readonly SessionMessage[]
): OverflowContinuationSource | null => {
	const durable = messages.filter((message) => !isTerminalRow(message));
	let protectedStart = -1;
	for (let index = durable.length - 1; index >= 0; index -= 1) {
		const message = durable[index];
		if (
			message !== undefined &&
			message.role === "assistant" &&
			hasCompletedTool(message)
		) {
			protectedStart = index;
			break;
		}
	}
	if (protectedStart < 0) {
		return null;
	}
	const protectedMessages = durable.slice(protectedStart);
	if (protectedMessages.length === 0) {
		return null;
	}
	return {
		protectedMessageIds: protectedMessages.map((message) => message.id),
		sourceMessages: durable,
	};
};

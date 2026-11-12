import {
	isSessionToolPart,
	type SessionMessage,
	type SessionToolPart,
} from "./message";

export type ContinuationContextMessages =
	| Readonly<{
			anchor: SessionMessage;
			kind: "ready";
			lastMessage: SessionMessage;
	  }>
	| Readonly<{ kind: "rejected"; reason: string }>;

const incompleteToolCallReason = "Incomplete Tool Calls cannot be continued.";

const isCompleteToolCall = (part: SessionToolPart): boolean =>
	part.state === "output-denied" ||
	(part.state === "output-available" && "output" in part) ||
	(part.state === "output-error" &&
		typeof part.errorText === "string" &&
		part.errorText.length > 0);

/** Validates the only context cuts from which generic continuation is safe. */
export const validateSessionInputContext = (
	context: readonly SessionMessage[]
):
	| Readonly<{ kind: "ready" }>
	| Readonly<{ kind: "rejected"; reason: string }> =>
	context.some(({ parts }) =>
		parts.some((part) => isSessionToolPart(part) && !isCompleteToolCall(part))
	)
		? { kind: "rejected", reason: incompleteToolCallReason }
		: { kind: "ready" };

export const findContinuationContextMessages = (
	context: readonly SessionMessage[],
	options: Readonly<{ terminalAssistantMessageId?: SessionMessage["id"] }> = {}
): ContinuationContextMessages => {
	const lastMessage = context.at(-1);
	if (lastMessage === undefined) {
		return {
			kind: "rejected",
			reason: "The Agent Session has no context to continue.",
		};
	}
	const inputContextValidation = validateSessionInputContext(context);
	if (inputContextValidation.kind === "rejected") {
		return inputContextValidation;
	}
	const toolParts = lastMessage.parts.filter(isSessionToolPart);
	const completeToolCall =
		lastMessage.role === "assistant" &&
		toolParts.length > 0 &&
		toolParts.every(isCompleteToolCall);
	const terminalAssistantCheckpoint =
		lastMessage.role === "assistant" &&
		lastMessage.id === options.terminalAssistantMessageId &&
		toolParts.length === 0;
	if (
		!(
			lastMessage.role === "user" ||
			completeToolCall ||
			terminalAssistantCheckpoint
		)
	) {
		return {
			kind: "rejected",
			reason:
				"The Agent Session can only continue from a user message or completed Tool Call.",
		};
	}
	let anchor: SessionMessage | undefined;
	for (let index = context.length - 1; index >= 0; index -= 1) {
		const candidate = context[index];
		if (candidate?.role === "user") {
			anchor = candidate;
			break;
		}
	}
	if (anchor === undefined) {
		return {
			kind: "rejected",
			reason: "The Agent Session has no user message to continue.",
		};
	}
	return { kind: "ready", anchor, lastMessage };
};

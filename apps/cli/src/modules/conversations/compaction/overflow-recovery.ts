import {
	type CodingAgentUIMessage,
	sanitizeInterruptedMessagesForModel,
} from "@wincode/ai";
import { classifyProviderError } from "@wincode/ai/server";
import type {
	CompactConversationInput,
	CompactConversationResult,
	ConversationCompactionModule,
} from "./compaction";

export class OverflowRecoveryError extends Error {
	readonly code: "disabled" | "replay-failed" | "replay-exhausted";

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

export type OverflowReplay = {
	activeMessages: CodingAgentUIMessage[];
	entry: CompactConversationResult["entry"];
	originalMessageId: string;
};
export type OverflowRecoveryInput = {
	compaction: ConversationCompactionModule;
	compactionInput: Omit<CompactConversationInput, "conversation" | "trigger">;
	conversation: {
		messages: readonly CodingAgentUIMessage[];
		sessionId: string;
	};
	enabled: boolean;
	originalMessageId: string;
	attempt: number;
	error: unknown;
	replay: (replay: OverflowReplay) => Promise<void>;
	compact?: (
		input: CompactConversationInput
	) => Promise<CompactConversationResult>;
};

export const prepareOverflowReplayMessages = (
	messages: readonly CodingAgentUIMessage[],
	originalMessageId: string
): CodingAgentUIMessage[] => {
	const originalIndex = messages.findIndex(
		(message) => message.id === originalMessageId && message.role === "user"
	);
	if (originalIndex === -1) {
		throw new OverflowRecoveryError(
			"replay-failed",
			"Context overflow recovery could not find the original user message."
		);
	}
	return sanitizeInterruptedMessagesForModel([
		...messages.slice(0, originalIndex + 1),
	]);
};

export const recoverContextOverflow = async ({
	compaction,
	compactionInput,
	conversation,
	enabled,
	originalMessageId,
	attempt,
	error,
	replay,
	compact: compactOverride,
}: OverflowRecoveryInput): Promise<CompactConversationResult | null> => {
	if (classifyProviderError(error) !== "context-overflow") {
		throw error;
	}
	if (!enabled) {
		throw new OverflowRecoveryError(
			"disabled",
			"The provider rejected the context size; overflow recovery is disabled.",
			{ cause: error }
		);
	}
	if (attempt > 0) {
		throw new OverflowRecoveryError(
			"replay-exhausted",
			"Context overflow recovery already replayed this turn; the provider still rejected the request.",
			{ cause: error }
		);
	}

	const replayMessages = prepareOverflowReplayMessages(
		conversation.messages,
		originalMessageId
	);
	let result: CompactConversationResult;
	try {
		const compactConversation = compactOverride ?? compaction.compact;
		result = await compactConversation({
			...compactionInput,
			conversation: {
				messages: replayMessages,
				sessionId: conversation.sessionId,
			},
			trigger: "overflow",
		});
	} catch (compactionError) {
		const detail =
			compactionError instanceof Error ? ` ${compactionError.message}` : "";
		throw new OverflowRecoveryError(
			"replay-failed",
			`Context overflow recovery could not compact the conversation.${detail}`,
			{ cause: compactionError }
		);
	}
	await replay({
		activeMessages: result.activeMessages,
		entry: result.entry,
		originalMessageId,
	});
	return result;
};

export { isContextOverflowError } from "@wincode/ai/server";

import type { SessionMessageId } from "@wincode/agent-core";
import { isModelContextOverflowError } from "@wincode/ai/model-failures";
import { getErrorMessage } from "@wincode/runtime-utils";
import type { Except } from "type-fest";
import type { SessionId } from "@/shared/identifiers";
import type { SessionMessage } from "../message";
import { sanitizeInterruptedSessionMessages } from "../message";
import type {
	CompactSessionInput,
	CompactSessionResult,
	SessionCompactionModule,
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
	activeMessages: SessionMessage[];
	entry: CompactSessionResult["entry"];
	originalMessageId: SessionMessageId;
};
export type OverflowRecoveryInput = {
	compaction: SessionCompactionModule;
	compactionInput: Except<CompactSessionInput, "session" | "trigger">;
	session: {
		messages: readonly SessionMessage[];
		sessionId: SessionId;
	};
	enabled: boolean;
	originalMessageId: SessionMessageId;
	attempt: number;
	error: unknown;
	replay: (replay: OverflowReplay) => Promise<void>;
	compact?: (input: CompactSessionInput) => Promise<CompactSessionResult>;
};

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

export const recoverContextOverflow = async ({
	compaction,
	compactionInput,
	session,
	enabled,
	originalMessageId,
	attempt,
	error,
	replay,
	compact: compactOverride,
}: OverflowRecoveryInput): Promise<CompactSessionResult | null> => {
	if (!isModelContextOverflowError(error)) {
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
		session.messages,
		originalMessageId
	);
	let result: CompactSessionResult;
	try {
		const compactSession = compactOverride ?? compaction.compact;
		result = await compactSession({
			...compactionInput,
			session: {
				messages: replayMessages,
				sessionId: session.sessionId,
			},
			trigger: "overflow",
		});
	} catch (compactionError) {
		const detail = getErrorMessage(compactionError, "");
		throw new OverflowRecoveryError(
			"replay-failed",
			`Context overflow recovery could not compact the session.${detail}`,
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

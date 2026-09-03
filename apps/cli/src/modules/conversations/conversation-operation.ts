import { createAgentTurnAbortReason } from "@wincode/agent-core";
import type {
	AgentId,
	ChatModelSelection,
	ModelVariant,
	ResolvedAgentRuntime,
} from "@wincode/ai";
import type { FileUIPart } from "@wincode/ai/client";
import type { SkillContext } from "@wincode/skills";

export type ConversationSendInput = {
	agent: AgentId;
	conversationModel: ChatModelSelection;
	conversationVariant?: ModelVariant;
	model: ChatModelSelection;
	variant?: ModelVariant;
	resolvedAgent?: ResolvedAgentRuntime;
	/** Prompt to append as a fresh user message. */
	userText?: string;
	files?: FileUIPart[];
	skill?: SkillContext;
	/** Existing stored user message to run without appending another message. */
	messageId?: string;
};

export type ConversationSendOutcome =
	| { readonly rejected: false }
	| { readonly rejected: true; readonly reason: string };

export type ConversationSendExecutor = (
	input: ConversationSendInput,
	signal: AbortSignal
) => Promise<ConversationSendOutcome>;

export type ConversationOperation = {
	/** Starts one application-owned send through the current Conversation path. */
	send: (input: ConversationSendInput) => Promise<ConversationSendOutcome>;
	/** Waits until the active send, if any, has settled. */
	waitForIdle: () => Promise<boolean>;
	/** Cancels the active send and its owned execution signal. */
	cancel: () => void;
	/** Interrupts the active turn while preserving the existing terminal handling. */
	interrupt: (preserveToolCallId?: string) => void;
};

export type CreateConversationOperationOptions = {
	execute: ConversationSendExecutor;
	/** Optional deadline applied to each active send. */
	deadlineMs?: number;
	onInterrupt?: (preserveToolCallId?: string) => void;
};

const ACTIVE_SEND_ERROR = "A conversation send is already active.";
type ConversationDeadlineTimer = ReturnType<typeof setTimeout>;

export const createConversationOperation = ({
	deadlineMs,
	execute,
	onInterrupt,
}: CreateConversationOperationOptions): ConversationOperation => {
	if (
		deadlineMs !== undefined &&
		(!Number.isInteger(deadlineMs) || deadlineMs < 0)
	) {
		throw new Error(
			"Conversation send deadline must be a non-negative integer."
		);
	}

	let active:
		| {
				controller: AbortController;
				promise: Promise<ConversationSendOutcome>;
				deadlineTimer?: ConversationDeadlineTimer;
		  }
		| undefined;

	const send = async (
		input: ConversationSendInput
	): Promise<ConversationSendOutcome> => {
		if (active) {
			return {
				rejected: true,
				reason: ACTIVE_SEND_ERROR,
			};
		}

		const controller = new AbortController();
		const deadlineTimer =
			deadlineMs === undefined
				? undefined
				: setTimeout(() => {
						controller.abort(createAgentTurnAbortReason("deadline-exceeded"));
					}, deadlineMs);
		const clearIfCurrent = (): void => {
			if (active?.controller !== controller) {
				return;
			}
			if (active.deadlineTimer !== undefined) {
				clearTimeout(active.deadlineTimer);
			}
			active = undefined;
		};
		const promise = (async () => {
			await Promise.resolve();
			try {
				return await execute(input, controller.signal);
			} finally {
				clearIfCurrent();
			}
		})();
		active = { controller, deadlineTimer, promise };
		return promise;
	};
	const waitForIdle = async (): Promise<boolean> => {
		const current = active;
		if (!current) {
			return true;
		}
		await current.promise.catch(() => undefined);
		return !current.controller.signal.aborted;
	};

	const cancel = (): void => {
		const current = active;
		if (!current) {
			return;
		}
		current.controller.abort(createAgentTurnAbortReason("cancelled"));
	};

	const interrupt = (preserveToolCallId?: string): void => {
		active?.controller.abort(createAgentTurnAbortReason("interrupted"));
		onInterrupt?.(preserveToolCallId);
	};
	return { cancel, interrupt, send, waitForIdle };
};

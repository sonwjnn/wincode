import type {
	AgentId,
	ChatModelSelection,
	ModelVariant,
	ResolvedAgentRuntime,
	SkillContext,
} from "@wincode/ai";
import type { FileUIPart } from "@wincode/ai/client";

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
	onInterrupt?: (preserveToolCallId?: string) => void;
};

const ACTIVE_SEND_ERROR = "A conversation send is already active.";

export const createConversationOperation = ({
	execute,
	onInterrupt,
}: CreateConversationOperationOptions): ConversationOperation => {
	let active:
		| {
				controller: AbortController;
				promise: Promise<ConversationSendOutcome>;
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
		let promise: Promise<ConversationSendOutcome>;
		promise = (async () => {
			await Promise.resolve();
			try {
				return await execute(input, controller.signal);
			} finally {
				if (active?.promise === promise) {
					active = undefined;
				}
			}
		})();
		active = { controller, promise };
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

	const cancel = () => {
		const current = active;
		if (!current) {
			return;
		}
		current.controller.abort();
	};

	const interrupt = (preserveToolCallId?: string) => {
		onInterrupt?.(preserveToolCallId);
		active?.controller.abort();
	};
	return { cancel, interrupt, send, waitForIdle };
};

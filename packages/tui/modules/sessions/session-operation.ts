import type {
	AgentId,
	AgentTurnDelegation,
	SessionMessageId,
	ToolCallId,
} from "@wincode/agent-core";
import { createAgentTurnAbortReason } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { isUndefined } from "@wincode/runtime-utils";
import type { SkillContext } from "@wincode/skills";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { SessionResolvedAgent } from "./engine/types";

/**
 * The visible composition one Submission was composed from: the text the
 * composer showed (attachment and pasted-text markers included), its
 * attachments, and the pasted text those markers stand for. A Recall restores
 * this, so a Queued Submission keeps it unchanged while it waits.
 */
export type SessionSubmissionComposition = Readonly<{
	/** Where each attachment marker sits in `text`, in attachment order. */
	fileTokens?: readonly { start: number; token: string }[];
	files: readonly SessionFilePart[];
	/** The pasted-text summaries in `text`, in the order they appear. */
	pastedText?: readonly { text: string; token: string }[];
	text: string;
}>;

export type SessionSendInput = Readonly<{
	agent: AgentId;
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	model: ChatModelSelection;
	variant?: ModelVariant;
	resolvedAgent?: SessionResolvedAgent;
	/** Correlation for an internally delegated Subagent execution. */
	delegation?: AgentTurnDelegation;
	/** Prompt to append as a fresh user message. */
	userText?: string;
	files?: readonly SessionFilePart[];
	skill?: SkillContext;
	/** Existing stored user message to run without appending another message. */
	messageId?: SessionMessageId;
	/** The composition this submission was accepted from, when the composer held one. */
	composition?: SessionSubmissionComposition;
}>;

export type SessionSendOutcome =
	| { readonly rejected: false }
	| { readonly rejected: true; readonly reason: string };

export type SessionSendExecutor = (
	input: SessionSendInput,
	signal: AbortSignal
) => Promise<SessionSendOutcome>;

export type SessionOperation = {
	/** Starts one application-owned send through the current Session path. */
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	/** Cancels the active send and its owned execution signal. */
	cancel: () => void;
	/** Interrupts the active turn while preserving the existing terminal handling. */
	interrupt: (preserveToolCallId?: ToolCallId) => void;
	/** Resolves after the active send, including its durable checkpoint, settles. */
	waitForIdle: () => Promise<void>;
};

export type CreateSessionOperationOptions = {
	execute: SessionSendExecutor;
	/** Optional deadline applied to each active send. */
	deadlineMs?: number;
	onInterrupt?: (preserveToolCallId?: ToolCallId) => void;
};

const ACTIVE_SEND_ERROR = "A session send is already active.";
type SessionDeadlineTimer = ReturnType<typeof setTimeout>;

export const createSessionOperation = ({
	deadlineMs,
	execute,
	onInterrupt,
}: CreateSessionOperationOptions): SessionOperation => {
	if (
		!isUndefined(deadlineMs) &&
		(!Number.isInteger(deadlineMs) || deadlineMs < 0)
	) {
		throw new Error("Session send deadline must be a non-negative integer.");
	}

	let active:
		| {
				controller: AbortController;
				promise: Promise<SessionSendOutcome>;
				deadlineTimer?: SessionDeadlineTimer;
		  }
		| undefined;

	const send = async (input: SessionSendInput): Promise<SessionSendOutcome> => {
		if (active) {
			return {
				rejected: true,
				reason: ACTIVE_SEND_ERROR,
			};
		}

		const controller = new AbortController();
		const deadlineTimer = isUndefined(deadlineMs)
			? undefined
			: setTimeout(() => {
					controller.abort(createAgentTurnAbortReason("deadline-exceeded"));
				}, deadlineMs);
		const clearIfCurrent = (): void => {
			if (active?.controller !== controller) {
				return;
			}
			if (!isUndefined(active.deadlineTimer)) {
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
	const cancel = (): void => {
		const current = active;
		if (!current) {
			return;
		}
		current.controller.abort(createAgentTurnAbortReason("cancelled"));
	};

	const interrupt = (preserveToolCallId?: ToolCallId): void => {
		active?.controller.abort(createAgentTurnAbortReason("interrupted"));
		onInterrupt?.(preserveToolCallId);
	};
	const waitForIdle = async (): Promise<void> => {
		while (active) {
			const current = active;
			await current.promise.catch(() => undefined);
		}
	};

	return { cancel, interrupt, send, waitForIdle };
};

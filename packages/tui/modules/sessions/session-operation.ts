import type { AgentId, AgentTurnDelegation } from "@wincode/agent-core";
import { createAgentTurnAbortReason } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { SkillContext } from "@wincode/skills";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { ResolvedCodingAgent } from "../agents/built-ins";

export type SessionSendInput = {
	agent: AgentId;
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	model: ChatModelSelection;
	variant?: ModelVariant;
	resolvedAgent?: ResolvedCodingAgent;
	/** Correlation for an internally delegated Subagent execution. */
	delegation?: AgentTurnDelegation;
	/** Prompt to append as a fresh user message. */
	userText?: string;
	files?: SessionFilePart[];
	skill?: SkillContext;
	/** Existing stored user message to run without appending another message. */
	messageId?: string;
};

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
	/** Waits until the active send, if any, has settled. */
	waitForIdle: () => Promise<boolean>;
	/** Cancels the active send and its owned execution signal. */
	cancel: () => void;
	/** Interrupts the active turn while preserving the existing terminal handling. */
	interrupt: (preserveToolCallId?: string) => void;
};

export type CreateSessionOperationOptions = {
	execute: SessionSendExecutor;
	/** Optional deadline applied to each active send. */
	deadlineMs?: number;
	onInterrupt?: (preserveToolCallId?: string) => void;
};

const ACTIVE_SEND_ERROR = "A session send is already active.";
type SessionDeadlineTimer = ReturnType<typeof setTimeout>;

export const createSessionOperation = ({
	deadlineMs,
	execute,
	onInterrupt,
}: CreateSessionOperationOptions): SessionOperation => {
	if (
		deadlineMs !== undefined &&
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

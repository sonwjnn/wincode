import {
	createAgentTurnAbortReason,
	type SessionMessageId,
} from "@wincode/agent-core";
import { isError } from "@wincode/utils";
import type { SessionSendInput, SessionSendOutcome } from "../submission-types";
import { sessionSendCancelled } from "./submission";

export type SessionActiveSend = {
	controller: AbortController;
	deadlineTimer: NodeJS.Timeout;
	promise: Promise<SessionSendOutcome>;
};

export type SessionSubmissionStart = Readonly<{
	messageId: SessionMessageId | undefined;
	ownsTurnReservation: boolean;
}>;

export type SessionSubmissionCommandPort = Readonly<{
	runInSubmissionLane: (
		input: SessionSendInput,
		options: RunSubmissionOptions,
		run: () => Promise<SessionSendOutcome>
	) => Promise<SessionSendOutcome>;
	cancelCompaction: () => void;
	deadlineMs: number;
	getActiveSend: () => SessionActiveSend | undefined;
	prepareContinuation: (
		input: SessionSendInput
	) => Promise<SessionContinuationPreparation>;
	isClosed: () => boolean;
	pipelineSend: (
		input: SessionSendInput,
		signal: AbortSignal,
		onExecutionStarted?: () => void
	) => Promise<SessionSendOutcome>;
	publishError: (error: Error) => void;
	setActiveSend: (active: SessionActiveSend | undefined) => void;
	waitForActiveSend: () => Promise<void>;
}>;

type RunSubmissionOptions = Readonly<{
	onExecutionStarted?: () => void;
	reportFailure?: boolean;
}>;
type SessionContinuationPreparation =
	| { readonly kind: "closed" }
	| { readonly kind: "busy" }
	| { readonly kind: "ready"; readonly input: SessionSendInput };
export type SessionSubmissionCommand = Readonly<{
	abortActiveSend: (
		reason: "cancelled" | "deadline-exceeded" | "interrupted"
	) => void;
	continueContext: (
		input: SessionSendInput,
		onExecutionStarted: () => void
	) => Promise<SessionSendOutcome>;
	runSubmission: (
		input: SessionSendInput,
		options?: RunSubmissionOptions
	) => Promise<SessionSendOutcome>;
	waitForActiveSend: () => Promise<void>;
}>;

const ACTIVE_SESSION_SEND_ERROR = "A session send is already active.";

/** Orders one submission through its active send and the Session command lane. */
export const createSessionSubmissionCommand = (
	port: SessionSubmissionCommandPort
): SessionSubmissionCommand => {
	const abortActiveSend = (
		reason: "cancelled" | "deadline-exceeded" | "interrupted"
	): void => {
		const active = port.getActiveSend();
		if (active !== undefined && !active.controller.signal.aborted) {
			active.controller.abort(createAgentTurnAbortReason(reason));
		}
	};
	const runActiveSend = (
		input: SessionSendInput,
		onExecutionStarted?: () => void
	): Promise<SessionSendOutcome> => {
		if (port.getActiveSend() !== undefined) {
			return Promise.resolve({
				rejected: true,
				reason: ACTIVE_SESSION_SEND_ERROR,
			});
		}
		const controller = new AbortController();
		const deadlineTimer = setTimeout(() => {
			const active = port.getActiveSend();
			if (active?.controller === controller && !controller.signal.aborted) {
				active.controller.abort(
					createAgentTurnAbortReason("deadline-exceeded")
				);
			}
		}, port.deadlineMs);
		const promise = (async (): Promise<SessionSendOutcome> => {
			await Promise.resolve();
			try {
				if (controller.signal.aborted) {
					return sessionSendCancelled(controller.signal);
				}
				const stop = (): void => {
					port.cancelCompaction();
				};
				controller.signal.addEventListener("abort", stop, { once: true });
				try {
					return await port.pipelineSend(
						input,
						controller.signal,
						onExecutionStarted
					);
				} catch (error) {
					if (!port.isClosed()) {
						port.publishError(
							isError(error) ? error : new Error("Session failed.")
						);
					}
					throw error;
				} finally {
					controller.signal.removeEventListener("abort", stop);
				}
			} finally {
				const active = port.getActiveSend();
				if (active?.controller === controller) {
					clearTimeout(active.deadlineTimer);
					port.setActiveSend(undefined);
				}
			}
		})();
		port.setActiveSend({ controller, deadlineTimer, promise });
		return promise;
	};
	const waitForActiveSend = (): Promise<void> => port.waitForActiveSend();
	const runSubmission = (
		input: SessionSendInput,
		options: RunSubmissionOptions = {}
	): Promise<SessionSendOutcome> =>
		port.runInSubmissionLane(input, options, () =>
			runActiveSend(input, options.onExecutionStarted)
		);
	const continueContext = async (
		input: SessionSendInput,
		onExecutionStarted: () => void
	): Promise<SessionSendOutcome> => {
		const preparation = await port.prepareContinuation(input);
		if (preparation.kind === "closed") {
			return { rejected: true, reason: "The session has ended." };
		}
		if (preparation.kind === "busy") {
			return { rejected: true, reason: "The Agent Session is busy." };
		}
		return runSubmission(preparation.input, { onExecutionStarted });
	};
	return {
		abortActiveSend,
		continueContext,
		runSubmission,
		waitForActiveSend,
	};
};

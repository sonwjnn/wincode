import {
	createAgentTurnAbortReason,
	createAgentTurnId,
	type SessionMessageId,
} from "@wincode/agent-core";
import { getErrorMessage, isError } from "@wincode/runtime-utils";
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
	beginSubmission: (input: SessionSendInput) => SessionSubmissionStart;
	cancelCompaction: () => void;
	closeApprovals: () => void;
	deadlineMs: number;
	drainQueuedSubmissions: () => Promise<void>;
	finishSubmission: (
		input: SessionSendInput,
		ownsTurnReservation: boolean
	) => void;
	getActiveSend: () => SessionActiveSend | undefined;
	isBusyForContinuation: () => boolean;
	isClosed: () => boolean;
	pipelineSend: (
		input: SessionSendInput,
		signal: AbortSignal
	) => Promise<SessionSendOutcome>;
	publishError: (error: Error) => void;
	rememberContinuationInput: (input: SessionSendInput) => void;
	reportSubmissionFailure: (
		input: SessionSendInput,
		messageId: SessionMessageId | undefined,
		reason: string
	) => void;
	setActiveSend: (active: SessionActiveSend | undefined) => void;
	trackBackgroundTask: (task: Promise<unknown>) => void;
	waitForSubmissionLane: () => Promise<void>;
}>;

export type SessionSubmissionCommand = Readonly<{
	abortActiveSend: (
		reason: "cancelled" | "deadline-exceeded" | "interrupted"
	) => void;
	continueContext: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	runSubmission: (input: SessionSendInput) => Promise<SessionSendOutcome>;
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
		input: SessionSendInput
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
					port.closeApprovals();
				};
				controller.signal.addEventListener("abort", stop, { once: true });
				try {
					return await port.pipelineSend(input, controller.signal);
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
	const waitForActiveSend = async (): Promise<void> => {
		while (port.getActiveSend() !== undefined) {
			await port.getActiveSend()?.promise.catch(() => undefined);
		}
	};
	const runSubmission = async (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		const { messageId, ownsTurnReservation } = port.beginSubmission(input);
		try {
			const outcome = await runActiveSend(input);
			if (outcome.rejected) {
				port.reportSubmissionFailure(input, messageId, outcome.reason);
			}
			return outcome;
		} catch (error) {
			port.reportSubmissionFailure(
				input,
				messageId,
				getErrorMessage(error, "The Submission failed.")
			);
			throw error;
		} finally {
			port.finishSubmission(input, ownsTurnReservation);
		}
	};
	const continueContext = async (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		if (port.isClosed()) {
			return { rejected: true, reason: "The session has ended." };
		}
		await waitForActiveSend();
		await port.waitForSubmissionLane();
		if (port.isClosed()) {
			return { rejected: true, reason: "The session has ended." };
		}
		if (port.isBusyForContinuation()) {
			return { rejected: true, reason: "The Agent Session is busy." };
		}
		const continuationInput = {
			...input,
			turnId: input.turnId ?? createAgentTurnId(),
		};
		port.rememberContinuationInput(continuationInput);
		return runSubmission(continuationInput);
	};
	return {
		abortActiveSend,
		continueContext,
		runSubmission,
		waitForActiveSend,
	};
};

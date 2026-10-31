import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	type SubmissionId,
	toSessionMessageId,
	toSubmissionId,
} from "@wincode/agent-core";
import { getErrorMessage, isUndefined, omitUndefined } from "@wincode/utils";
import { toQueuedSubmissionId } from "@/shared/identifiers";
import { createSessionUserMessage, type SessionFilePart } from "../message";
import type {
	SessionSendInput,
	SessionSendOutcome,
	SessionSubmissionComposition,
} from "../submission-types";
import {
	SESSION_PROJECTION_BLOCKED_ERROR,
	SESSION_SHUT_DOWN_ERROR,
} from "./session-messages";
import type {
	AgentSessionPorts,
	SessionQueuedSendInput,
	SessionQueuedSubmission,
	SessionSteeringAdmission,
	SessionSteeringCommitReceipt,
	SessionSteeringMessage,
	SessionSubmissionAdmission,
	SessionSubmissionEvent,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "./types";

const QUEUED_ATTACHMENT_ERROR = "Attachment data could not be stored.";

export type SessionInputExternalization = Readonly<{
	completion: Promise<SessionSendOutcome>;
	controller: AbortController;
}>;

type PreparedAdmission = Readonly<{
	admittedInput: SessionSendInput;
	messageId: SessionMessageId;
	submissionId: SubmissionId;
	turnId: AgentTurnId;
}>;

type SubmissionValidationFailure = Readonly<{
	rejected: true;
	reason: string;
}>;
type SubmissionValidationResult =
	| SubmissionValidationFailure
	| undefined
	| Promise<SubmissionValidationFailure | undefined>;

/** Current owner-derived facts that govern the input lane. */
export type SessionInputLaneState = Readonly<{
	canDrain: boolean;
	closed: boolean;
	executionBusy: boolean;
	queueDraining: boolean;
	submissionBusy: boolean;
	writeBlocked: boolean;
}>;

/**
 * What one input-lane step reads. The externalizations map is copied, so a step
 * that awaits cannot watch it change; the lane state is recomputed per read.
 */
export type SessionInputLaneSnapshot = Readonly<{
	/** In-flight attachment externalizations, keyed by Queued Submission. */
	externalizations: ReadonlyMap<
		SessionQueuedSubmission["id"],
		SessionInputExternalization
	>;
	lane: SessionInputLaneState;
	steeringMessages: readonly SessionSteeringMessage[];
}>;

/** A state transition only the Agent Session may apply. */
export type SessionInputLaneTransition =
	| {
			kind: "externalization-added";
			id: SessionQueuedSubmission["id"];
			controller: AbortController;
			completion: Promise<SessionSendOutcome>;
	  }
	| { kind: "externalization-removed"; id: SessionQueuedSubmission["id"] }
	/** Republishes the Snapshot so a queue change becomes observable. */
	| { kind: "queue-change-published" }
	| { kind: "queue-draining-set"; draining: boolean };

/** The work the lane hands back to the Agent Session. */
export type SessionInputLaneEffects = Readonly<{
	assertSubmissionSelection: (input: SessionSendInput) => void | Promise<void>;
	commitSteeringSubmission: (
		submission: SessionQueuedSubmission
	) => Promise<SessionSteeringCommitReceipt>;
	completeSteeringSubmission: (
		submission: SessionQueuedSubmission,
		receipt: SessionSteeringCommitReceipt
	) => void;
	emitSubmissionEvent: (event: SessionSubmissionEvent) => void;
	externalizeAttachments: AgentSessionPorts["attachments"]["externalize"];
	releaseAttachments: (attachmentIds: readonly string[]) => void;
	reportSubmissionFailure: (
		input: SessionSendInput,
		messageId: SessionMessageId | undefined,
		reason: string
	) => void;
	retainAttachments: (attachmentIds: readonly string[]) => void;
	retrySteeringMessage: (
		message: SessionSteeringMessage
	) => Promise<SessionSendOutcome>;
	runSteeringMessage: (
		message: SessionSteeringMessage
	) => Promise<SessionSendOutcome>;
	runSubmission: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	trackBackgroundTask: (task: Promise<unknown>) => void;
}>;

/**
 * The Agent Session as the input lane sees it: what it may read, the transitions
 * it may propose, the work it hands back, and the Stateful Agent it schedules.
 */
export type SessionInputLanePort = Readonly<{
	apply: (transition: SessionInputLaneTransition) => void;
	effects: SessionInputLaneEffects;
	inputScheduler: AgentSessionPorts["inputScheduler"];
	read: () => SessionInputLaneSnapshot;
}>;

export type SessionInputLaneWorkflow = Readonly<{
	drainQueuedSubmissions: () => Promise<void>;
	prompt: (input: SessionSendInput) => Promise<SessionSubmissionAdmission>;
	recallFailedTurnMessages: () => void;
	recallWaitingMessages: (
		ids?: readonly SessionWaitingMessageId[]
	) => Promise<SessionWaitingMessage[]>;
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	steer: () => Promise<SessionSteeringAdmission>;
}>;

/** The identity one admitted Submission runs under. */
type SubmissionIdentity = Readonly<{
	messageId: SessionMessageId;
	submissionId: SubmissionId;
	turnId: AgentTurnId;
}>;

const identityOf = (input: SessionSendInput): SubmissionIdentity => ({
	messageId:
		input.messageId ??
		input.reservedMessageId ??
		toSessionMessageId(`msg-${crypto.randomUUID()}`),
	submissionId:
		input.submissionId ?? toSubmissionId(`submission-${crypto.randomUUID()}`),
	turnId: input.turnId ?? createAgentTurnId(),
});

/** The composition a Submission carries, defaulted from its raw fields. */
const compositionOf = (input: SessionSendInput): SessionSubmissionComposition =>
	input.composition ?? {
		files: input.files ?? [],
		text: input.userText ?? "",
	};

const queuedAttachmentIds = (input: SessionQueuedSendInput): string[] =>
	input.composition.files.flatMap(({ attachmentId }) =>
		isUndefined(attachmentId) ? [] : [attachmentId]
	);

const subtractAttachmentIds = (
	attachmentIds: readonly string[],
	subtracted: readonly string[]
): string[] => {
	const counts = new Map<string, number>();
	for (const id of subtracted) {
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return attachmentIds.filter((id) => {
		const count = counts.get(id) ?? 0;
		if (count === 0) {
			return true;
		}
		if (count === 1) {
			counts.delete(id);
		} else {
			counts.set(id, count - 1);
		}
		return false;
	});
};

const waitingMessageMatches = (
	ids: readonly SessionWaitingMessageId[] | undefined,
	id: SessionWaitingMessageId,
	submissionId: SessionWaitingMessageId | undefined
): boolean =>
	ids === undefined ||
	ids.includes(id) ||
	(submissionId !== undefined && ids.includes(submissionId));

const recalledSubmissionEvent = (
	message: SessionWaitingMessage,
	reason: "recall" | "turn-failed"
): SessionSubmissionEvent => ({
	kind: "recalled",
	messageId: message.messageId,
	reason,
	submissionId: message.submissionId,
	...omitUndefined({
		composition:
			reason === "turn-failed" ? message.input.composition : undefined,
		turnId: message.input.turnId,
	}),
});

/** Application preparation and persistence effects around Stateful Agent input scheduling. */
export const createSessionInputLaneWorkflow = (
	port: SessionInputLanePort
): SessionInputLaneWorkflow => {
	const releaseQueuedAttachments = (
		submissions: readonly SessionQueuedSubmission[]
	): void => {
		const attachmentIds = submissions.flatMap(({ input }) =>
			queuedAttachmentIds(input)
		);
		if (attachmentIds.length > 0) {
			port.effects.releaseAttachments(attachmentIds);
		}
	};
	const storeCompositionFiles = async (
		files: readonly SessionFilePart[],
		signal: AbortSignal
	): Promise<SessionFilePart[]> => {
		if (files.every((file) => !isUndefined(file.attachmentId))) {
			return [...files];
		}
		const [stored] = await port.effects.externalizeAttachments(
			[createSessionUserMessage("", undefined, [], [...files])],
			signal
		);
		return (stored?.parts ?? []).filter(
			(part): part is SessionFilePart => part.type === "file"
		);
	};
	const drainSteeringHead = async (
		steering: SessionSteeringMessage
	): Promise<boolean> => {
		if (steering.status !== "pending") {
			return false;
		}
		const outcome = await port.effects.runSteeringMessage(steering);
		return !outcome.rejected;
	};
	const drainQueuedHead = async (
		next: SessionQueuedSubmission
	): Promise<boolean> => {
		if (port.read().externalizations.get(next.id) !== undefined) {
			return false;
		}
		const started = port.inputScheduler.takeQueuedSubmission(next.id);
		if (started === undefined) {
			return true;
		}
		port.apply({ kind: "queue-change-published" });
		try {
			const outcome = await port.effects.runSubmission(started.input);
			if (outcome.rejected) {
				return false;
			}
		} catch {
			recallFailedTurnMessages();
			return false;
		} finally {
			releaseQueuedAttachments([started]);
		}
		return true;
	};
	const drainQueueHead = async (): Promise<boolean> => {
		if (
			port.read().lane.closed ||
			port.inputScheduler.hasPendingSubmissionTransition()
		) {
			return false;
		}
		const steeringMessages = port.read().steeringMessages;
		const nextInput = port.inputScheduler.selectNextInput({
			hasSteeringMessages: steeringMessages.length > 0,
		});
		if (nextInput === "steering") {
			const steering = steeringMessages[0];
			return steering === undefined ? false : drainSteeringHead(steering);
		}
		if (nextInput !== "submission") {
			return false;
		}
		const next = port.inputScheduler.getQueuedSubmissions()[0];
		return next === undefined ? false : drainQueuedHead(next);
	};
	const drainQueueContents = async (): Promise<void> => {
		while (await drainQueueHead()) {
			// Continue only after the current head has been delivered.
		}
	};
	const drainQueuedSubmissions = async (): Promise<void> => {
		const lane = port.read().lane;
		if (lane.queueDraining || lane.closed || !lane.canDrain) {
			return;
		}
		port.apply({ draining: true, kind: "queue-draining-set" });
		try {
			await drainQueueContents();
		} finally {
			port.apply({ draining: false, kind: "queue-draining-set" });
		}
	};
	const failQueuedSubmissionAttachments = (
		queued: SessionQueuedSubmission
	): SessionSendOutcome => {
		const reason = port.read().lane.closed
			? SESSION_SHUT_DOWN_ERROR
			: QUEUED_ATTACHMENT_ERROR;
		const cleanup = port.inputScheduler
			.recallQueuedSubmissions((submission) => submission.id === queued.id)
			.then((removed) => {
				if (removed.length === 0) {
					return;
				}
				port.apply({ kind: "queue-change-published" });
				for (const submission of removed) {
					port.read().externalizations.get(submission.id)?.controller.abort();
				}
				releaseQueuedAttachments(removed);
				port.effects.reportSubmissionFailure(
					queued.input,
					queued.messageId,
					reason
				);
				port.effects.trackBackgroundTask(drainQueuedSubmissions());
			});
		port.effects.trackBackgroundTask(cleanup);
		return { rejected: true, reason };
	};
	const publishQueuedSubmissionAttachments = (
		queued: SessionQueuedSubmission,
		controller: AbortController,
		originalAttachmentIds: readonly string[],
		files: SessionFilePart[]
	): SessionSendOutcome => {
		const input: SessionQueuedSendInput = {
			...queued.input,
			composition: { ...queued.input.composition, files },
			files,
		};
		const storedAttachmentIds = queuedAttachmentIds(input);
		const newAttachmentIds = subtractAttachmentIds(
			storedAttachmentIds,
			originalAttachmentIds
		);
		const releasedAttachmentIds = subtractAttachmentIds(
			originalAttachmentIds,
			storedAttachmentIds
		);
		const stillQueued = port.inputScheduler
			.getQueuedSubmissions()
			.some((submission) => submission.id === queued.id);
		const closed = port.read().lane.closed;
		if (closed || controller.signal.aborted || !stillQueued) {
			if (newAttachmentIds.length > 0) {
				port.effects.releaseAttachments(newAttachmentIds);
			}
			return closed
				? { rejected: true, reason: SESSION_SHUT_DOWN_ERROR }
				: { rejected: false };
		}
		if (newAttachmentIds.length > 0) {
			port.effects.retainAttachments(newAttachmentIds);
		}
		if (releasedAttachmentIds.length > 0) {
			port.effects.releaseAttachments(releasedAttachmentIds);
		}
		if (!port.inputScheduler.replaceQueuedSubmission({ ...queued, input })) {
			if (newAttachmentIds.length > 0) {
				port.effects.releaseAttachments(newAttachmentIds);
			}
			return { rejected: false };
		}
		port.apply({ kind: "queue-change-published" });
		return { rejected: false };
	};
	const finishQueuedSubmissionAttachments = async (
		queued: SessionQueuedSubmission,
		controller: AbortController,
		originalAttachmentIds: readonly string[]
	): Promise<SessionSendOutcome> => {
		try {
			const files = await storeCompositionFiles(
				queued.input.composition.files,
				controller.signal
			);
			return publishQueuedSubmissionAttachments(
				queued,
				controller,
				originalAttachmentIds,
				files
			);
		} catch {
			return failQueuedSubmissionAttachments(queued);
		}
	};
	const acceptQueuedSubmission = (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		const composition = compositionOf(input);
		const { messageId, submissionId, turnId } = identityOf(input);
		const queuedInput: SessionQueuedSendInput = {
			...input,
			composition,
			files: composition.files,
			reservedMessageId: messageId,
			submissionId,
			turnId,
		};
		const queued: SessionQueuedSubmission = {
			id: toQueuedSubmissionId(crypto.randomUUID()),
			input: queuedInput,
			messageId,
			submissionId,
		};
		const originalAttachmentIds = queuedAttachmentIds(queuedInput);
		if (originalAttachmentIds.length > 0) {
			port.effects.retainAttachments(originalAttachmentIds);
		}
		const attachmentController = new AbortController();
		const completion = Promise.withResolvers<SessionSendOutcome>();
		port.apply({
			completion: completion.promise,
			controller: attachmentController,
			id: queued.id,
			kind: "externalization-added",
		});
		if (!port.inputScheduler.enqueueSubmission(queued)) {
			port.apply({ id: queued.id, kind: "externalization-removed" });
			releaseQueuedAttachments([queued]);
			return Promise.resolve({
				rejected: true,
				reason: SESSION_SHUT_DOWN_ERROR,
			});
		}
		port.apply({ kind: "queue-change-published" });
		const pending = finishQueuedSubmissionAttachments(
			queued,
			attachmentController,
			originalAttachmentIds
		);
		void pending.then(completion.resolve, (error: unknown) =>
			completion.resolve({
				rejected: true,
				reason: getErrorMessage(error, QUEUED_ATTACHMENT_ERROR),
			})
		);
		return pending.finally(() => {
			port.apply({ id: queued.id, kind: "externalization-removed" });
			port.effects.trackBackgroundTask(drainQueuedSubmissions());
		});
	};
	const commitQueuedSteering = async (
		queued: SessionQueuedSubmission
	): Promise<SessionSteeringCommitReceipt> => {
		try {
			const externalization = port.read().externalizations.get(queued.id);
			if (externalization !== undefined) {
				const outcome = await externalization.completion;
				if (outcome.rejected) {
					return {
						kind: "rejected",
						admission: {
							kind: "rejected",
							messageId: queued.messageId,
							reason: outcome.reason,
							submissionId: queued.submissionId,
						},
					};
				}
			}
			const current = port.inputScheduler.getQueuedSubmissions()[0];
			if (current?.id !== queued.id) {
				return {
					kind: "rejected",
					admission: {
						kind: "rejected",
						messageId: queued.messageId,
						reason: "The queued Submission is no longer waiting.",
						submissionId: queued.submissionId,
					},
				};
			}
			await port.effects.assertSubmissionSelection(current.input);
			return await port.effects.commitSteeringSubmission(current);
		} catch (error) {
			return {
				kind: "rejected",
				admission: {
					kind: "rejected",
					reason: getErrorMessage(error, "Could not commit the Submission."),
					messageId: queued.messageId,
					submissionId: queued.submissionId,
				},
			};
		}
	};
	const steer = async (): Promise<SessionSteeringAdmission> => {
		if (port.read().lane.closed) {
			return { kind: "rejected", reason: SESSION_SHUT_DOWN_ERROR };
		}
		if (port.read().lane.writeBlocked) {
			return { kind: "rejected", reason: SESSION_PROJECTION_BLOCKED_ERROR };
		}
		const result = await port.inputScheduler.steerQueuedSubmission(
			async (queued) => {
				const receipt = await commitQueuedSteering(queued);
				return {
					committed: receipt.kind === "committed",
					receipt,
				};
			},
			(queued, receipt) =>
				port.effects.completeSteeringSubmission(queued, receipt)
		);
		if (result.kind === "empty") {
			return { kind: "empty" };
		}
		port.effects.trackBackgroundTask(drainQueuedSubmissions());
		return result.receipt.admission;
	};
	const recallWaitingMessagesWithReason = (
		ids: readonly SessionWaitingMessageId[] | undefined,
		reason: "recall" | "turn-failed"
	): Promise<SessionWaitingMessage[]> => {
		const recalled = port.inputScheduler.recallQueuedSubmissions(
			(submission) =>
				waitingMessageMatches(ids, submission.id, submission.submissionId),
			(submissions) => {
				port.apply({ kind: "queue-change-published" });
				for (const submission of submissions) {
					port.read().externalizations.get(submission.id)?.controller.abort();
				}
				releaseQueuedAttachments(submissions);
				for (const submission of submissions) {
					port.effects.emitSubmissionEvent(
						recalledSubmissionEvent(submission, reason)
					);
				}
			}
		);
		return recalled.then((submissions) => {
			if (submissions.length > 0) {
				port.effects.trackBackgroundTask(drainQueuedSubmissions());
			}
			return [...submissions];
		});
	};
	const recallWaitingMessages = (
		ids?: readonly SessionWaitingMessageId[]
	): Promise<SessionWaitingMessage[]> =>
		recallWaitingMessagesWithReason(ids, "recall");
	const recallFailedTurnMessages = (): void => {
		port.effects.trackBackgroundTask(
			recallWaitingMessagesWithReason(undefined, "turn-failed")
		);
	};
	const prepareAdmission = (
		input: SessionSendInput,
		composition: SessionSubmissionComposition
	): PreparedAdmission => {
		const { messageId, submissionId, turnId } = identityOf(input);
		return {
			admittedInput: {
				...input,
				composition,
				files: composition.files,
				submissionId,
				turnId,
				userText: input.userText ?? composition.text,
				...omitUndefined({
					reservedMessageId:
						input.messageId === undefined ? messageId : undefined,
				}),
			},
			messageId,
			submissionId,
			turnId,
		};
	};
	const validateSubmissionSelection = (
		input: SessionSendInput
	): SubmissionValidationResult => {
		const selectionFailure = (error: unknown): SubmissionValidationFailure => ({
			rejected: true,
			reason: getErrorMessage(error, "Provider Model selection is not valid."),
		});
		try {
			const validation = port.effects.assertSubmissionSelection(input);
			return validation instanceof Promise
				? validation.then(() => undefined, selectionFailure)
				: undefined;
		} catch (error) {
			return selectionFailure(error);
		}
	};
	const prompt = async (
		input: SessionSendInput
	): Promise<SessionSubmissionAdmission> => {
		if (port.read().lane.closed) {
			return { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
		}
		if (port.read().lane.writeBlocked) {
			return { rejected: true, reason: SESSION_PROJECTION_BLOCKED_ERROR };
		}
		const validation = validateSubmissionSelection(input);
		const failure =
			validation instanceof Promise ? await validation : validation;
		if (failure !== undefined) {
			return failure;
		}
		const composition = compositionOf(input);
		const { admittedInput, messageId, submissionId, turnId } = prepareAdmission(
			input,
			composition
		);
		if (port.read().lane.submissionBusy) {
			port.effects.trackBackgroundTask(acceptQueuedSubmission(admittedInput));
			return {
				rejected: false,
				disposition: "queued",
				messageId,
				submissionId,
				turnId,
			};
		}
		void port.effects.runSubmission(admittedInput).catch(() => undefined);
		return {
			rejected: false,
			disposition: "started",
			messageId,
			submissionId,
			turnId,
		};
	};
	const send = async (input: SessionSendInput): Promise<SessionSendOutcome> => {
		if (port.read().lane.closed) {
			return { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
		}
		if (port.read().lane.writeBlocked) {
			return { rejected: true, reason: SESSION_PROJECTION_BLOCKED_ERROR };
		}
		const validation = validateSubmissionSelection(input);
		const failure =
			validation instanceof Promise ? await validation : validation;
		if (failure !== undefined) {
			return failure;
		}
		const composition = compositionOf(input);
		const { admittedInput } = prepareAdmission(input, composition);
		const failedSteering = port.read().steeringMessages[0];
		if (
			failedSteering?.status === "failed" &&
			failedSteering.message.id === input.messageId
		) {
			if (port.read().lane.executionBusy) {
				return {
					rejected: true,
					reason: "The committed Submission can only be retried while idle.",
				};
			}
			return await port.effects.retrySteeringMessage(failedSteering);
		}
		if (port.read().lane.submissionBusy) {
			const pending = acceptQueuedSubmission(admittedInput);
			port.effects.trackBackgroundTask(pending);
			return await pending;
		}
		return await port.effects.runSubmission(admittedInput);
	};
	return {
		drainQueuedSubmissions,
		prompt,
		recallFailedTurnMessages,
		recallWaitingMessages,
		send,
		steer,
	};
};

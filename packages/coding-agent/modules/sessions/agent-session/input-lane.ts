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
import type {
	AgentSessionPorts,
	LiveSessionSnapshot,
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

const SESSION_SHUT_DOWN_ERROR = "The session has ended.";
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

/** Application effects for opaque inputs scheduled by the Stateful Agent. */
export type SessionInputLanePort = Readonly<{
	addExternalization: (
		id: SessionQueuedSubmission["id"],
		controller: AbortController,
		completion: Promise<SessionSendOutcome>
	) => void;
	canDrainQueue: () => boolean;
	commitSteeringSubmission: (
		submission: SessionQueuedSubmission
	) => Promise<SessionSteeringCommitReceipt>;
	completeSteeringSubmission: (
		submission: SessionQueuedSubmission,
		receipt: SessionSteeringCommitReceipt
	) => void;
	getExternalization: (
		id: SessionQueuedSubmission["id"]
	) => SessionInputExternalization | undefined;
	getSnapshot: () => LiveSessionSnapshot;
	inputScheduler: AgentSessionPorts["inputScheduler"];
	isClosed: () => boolean;
	isExecutionBusy: () => boolean;
	isExternalizing: (id: SessionQueuedSubmission["id"]) => boolean;
	isQueueDraining: () => boolean;
	isSubmissionBusy: () => boolean;
	publishQueueChange: () => void;
	removeExternalization: (id: SessionQueuedSubmission["id"]) => void;
	reportSubmissionFailure: (
		input: SessionSendInput,
		messageId: SessionMessageId | undefined,
		reason: string
	) => void;
	retainAttachments: (attachmentIds: readonly string[]) => void;
	releaseAttachments: (attachmentIds: readonly string[]) => void;
	runSubmission: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	runSteeringMessage: (
		message: SessionSteeringMessage
	) => Promise<SessionSendOutcome>;
	retrySteeringMessage: (
		message: SessionSteeringMessage
	) => Promise<SessionSendOutcome>;
	setQueueDraining: (draining: boolean) => void;
	trackBackgroundTask: (task: Promise<unknown>) => void;
	emitSubmissionEvent: (event: SessionSubmissionEvent) => void;
	externalizeAttachments: AgentSessionPorts["attachments"]["externalize"];
}>;

export type SessionInputLaneWorkflow = Readonly<{
	acceptQueuedSubmission: (
		input: SessionSendInput
	) => Promise<SessionSendOutcome>;
	drainQueuedSubmissions: () => Promise<void>;
	prompt: (input: SessionSendInput) => Promise<SessionSubmissionAdmission>;
	recallFailedTurnMessages: () => void;
	recallWaitingMessages: (
		ids?: readonly SessionWaitingMessageId[]
	) => Promise<SessionWaitingMessage[]>;
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	steer: () => Promise<SessionSteeringAdmission>;
}>;

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
			port.releaseAttachments(attachmentIds);
		}
	};
	const storeCompositionFiles = async (
		files: readonly SessionFilePart[],
		signal: AbortSignal
	): Promise<SessionFilePart[]> => {
		if (files.every((file) => !isUndefined(file.attachmentId))) {
			return [...files];
		}
		const [stored] = await port.externalizeAttachments(
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
		const outcome = await port.runSteeringMessage(steering);
		return !outcome.rejected;
	};
	const drainQueuedHead = async (
		next: SessionQueuedSubmission
	): Promise<boolean> => {
		if (port.isExternalizing(next.id)) {
			return false;
		}
		const started = port.inputScheduler.takeQueuedSubmission(next.id);
		if (started === undefined) {
			return true;
		}
		port.publishQueueChange();
		try {
			const outcome = await port.runSubmission(started.input);
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
			port.isClosed() ||
			port.inputScheduler.hasPendingSubmissionTransition()
		) {
			return false;
		}
		const snapshot = port.getSnapshot();
		const nextInput = port.inputScheduler.selectNextInput({
			hasSteeringMessages: snapshot.steeringMessages.length > 0,
			hasDelegationReports: snapshot.pendingDelegationReports.length > 0,
		});
		if (nextInput === "steering") {
			const steering = snapshot.steeringMessages[0];
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
		if (port.isQueueDraining()) {
			return;
		}
		if (port.isClosed()) {
			return;
		}
		if (!port.canDrainQueue()) {
			return;
		}
		port.setQueueDraining(true);
		try {
			await drainQueueContents();
		} finally {
			port.setQueueDraining(false);
		}
	};
	const failQueuedSubmissionAttachments = (
		queued: SessionQueuedSubmission
	): SessionSendOutcome => {
		const reason = port.isClosed()
			? SESSION_SHUT_DOWN_ERROR
			: QUEUED_ATTACHMENT_ERROR;
		const cleanup = port.inputScheduler
			.recallQueuedSubmissions((submission) => submission.id === queued.id)
			.then((removed) => {
				if (removed.length === 0) {
					return;
				}
				port.publishQueueChange();
				for (const submission of removed) {
					port.getExternalization(submission.id)?.controller.abort();
				}
				releaseQueuedAttachments(removed);
				port.reportSubmissionFailure(queued.input, queued.messageId, reason);
				port.trackBackgroundTask(drainQueuedSubmissions());
			});
		port.trackBackgroundTask(cleanup);
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
		if (port.isClosed() || controller.signal.aborted || !stillQueued) {
			if (newAttachmentIds.length > 0) {
				port.releaseAttachments(newAttachmentIds);
			}
			return port.isClosed()
				? { rejected: true, reason: SESSION_SHUT_DOWN_ERROR }
				: { rejected: false };
		}
		if (newAttachmentIds.length > 0) {
			port.retainAttachments(newAttachmentIds);
		}
		if (releasedAttachmentIds.length > 0) {
			port.releaseAttachments(releasedAttachmentIds);
		}
		if (!port.inputScheduler.replaceQueuedSubmission({ ...queued, input })) {
			if (newAttachmentIds.length > 0) {
				port.releaseAttachments(newAttachmentIds);
			}
			return { rejected: false };
		}
		port.publishQueueChange();
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
		const composition: SessionSubmissionComposition = input.composition ?? {
			files: input.files ?? [],
			text: input.userText ?? "",
		};
		const submissionId =
			input.submissionId ?? toSubmissionId(`submission-${crypto.randomUUID()}`);
		const messageId =
			input.messageId ??
			input.reservedMessageId ??
			toSessionMessageId(`msg-${crypto.randomUUID()}`);
		const turnId = input.turnId ?? createAgentTurnId();
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
			port.retainAttachments(originalAttachmentIds);
		}
		const attachmentController = new AbortController();
		const completion = Promise.withResolvers<SessionSendOutcome>();
		port.addExternalization(
			queued.id,
			attachmentController,
			completion.promise
		);
		if (!port.inputScheduler.enqueueSubmission(queued)) {
			port.removeExternalization(queued.id);
			releaseQueuedAttachments([queued]);
			return Promise.resolve({
				rejected: true,
				reason: SESSION_SHUT_DOWN_ERROR,
			});
		}
		port.publishQueueChange();
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
			port.removeExternalization(queued.id);
			port.trackBackgroundTask(drainQueuedSubmissions());
		});
	};
	const commitQueuedSteering = async (
		queued: SessionQueuedSubmission
	): Promise<SessionSteeringCommitReceipt> => {
		try {
			const externalization = port.getExternalization(queued.id);
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
			return await port.commitSteeringSubmission(current);
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
		if (port.isClosed()) {
			return { kind: "rejected", reason: SESSION_SHUT_DOWN_ERROR };
		}
		const result = await port.inputScheduler.steerQueuedSubmission(
			async (queued) => {
				const receipt = await commitQueuedSteering(queued);
				return {
					committed: receipt.kind === "committed",
					receipt,
				};
			},
			(queued, receipt) => port.completeSteeringSubmission(queued, receipt)
		);
		if (result.kind === "empty") {
			return { kind: "empty" };
		}
		port.trackBackgroundTask(drainQueuedSubmissions());
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
				port.publishQueueChange();
				for (const submission of submissions) {
					port.getExternalization(submission.id)?.controller.abort();
				}
				releaseQueuedAttachments(submissions);
				for (const submission of submissions) {
					port.emitSubmissionEvent(recalledSubmissionEvent(submission, reason));
				}
			}
		);
		return recalled.then((submissions) => {
			if (submissions.length > 0) {
				port.trackBackgroundTask(drainQueuedSubmissions());
			}
			return [...submissions];
		});
	};
	const recallWaitingMessages = (
		ids?: readonly SessionWaitingMessageId[]
	): Promise<SessionWaitingMessage[]> =>
		recallWaitingMessagesWithReason(ids, "recall");
	const recallFailedTurnMessages = (): void => {
		port.trackBackgroundTask(
			recallWaitingMessagesWithReason(undefined, "turn-failed")
		);
	};
	const prepareAdmission = (
		input: SessionSendInput,
		composition: SessionSubmissionComposition
	): PreparedAdmission => {
		const submissionId =
			input.submissionId ?? toSubmissionId(`submission-${crypto.randomUUID()}`);
		const messageId =
			input.messageId ??
			input.reservedMessageId ??
			toSessionMessageId(`msg-${crypto.randomUUID()}`);
		const turnId = input.turnId ?? createAgentTurnId();
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
	const prompt = async (
		input: SessionSendInput
	): Promise<SessionSubmissionAdmission> => {
		if (port.isClosed()) {
			return { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
		}
		const composition: SessionSubmissionComposition = input.composition ?? {
			files: input.files ?? [],
			text: input.userText ?? "",
		};
		const { admittedInput, messageId, submissionId, turnId } = prepareAdmission(
			input,
			composition
		);
		if (port.isSubmissionBusy()) {
			port.trackBackgroundTask(acceptQueuedSubmission(admittedInput));
			return {
				rejected: false,
				disposition: "queued",
				messageId,
				submissionId,
				turnId,
			};
		}
		void port.runSubmission(admittedInput).catch(() => undefined);
		return {
			rejected: false,
			disposition: "started",
			messageId,
			submissionId,
			turnId,
		};
	};
	const send = async (input: SessionSendInput): Promise<SessionSendOutcome> => {
		if (port.isClosed()) {
			return { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
		}
		const composition: SessionSubmissionComposition = input.composition ?? {
			files: input.files ?? [],
			text: input.userText ?? "",
		};
		const { admittedInput } = prepareAdmission(input, composition);
		const failedSteering = port.getSnapshot().steeringMessages[0];
		if (
			failedSteering?.status === "failed" &&
			failedSteering.message.id === input.messageId
		) {
			if (port.isExecutionBusy()) {
				return {
					rejected: true,
					reason: "The committed Submission can only be retried while idle.",
				};
			}
			return await port.retrySteeringMessage(failedSteering);
		}
		if (port.isSubmissionBusy()) {
			const pending = acceptQueuedSubmission(admittedInput);
			port.trackBackgroundTask(pending);
			return await pending;
		}
		return await port.runSubmission(admittedInput);
	};
	return {
		acceptQueuedSubmission,
		drainQueuedSubmissions,
		prompt,
		recallFailedTurnMessages,
		recallWaitingMessages,
		send,
		steer,
	};
};

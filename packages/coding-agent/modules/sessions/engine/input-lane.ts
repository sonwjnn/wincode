import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	type SubmissionId,
	toSessionMessageId,
	toSubmissionId,
} from "@wincode/agent-core";
import {
	getErrorMessage,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
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

/** Session-owned queue and lane transitions requested by the input workflow. */
export type SessionInputLanePort = Readonly<{
	addExternalization: (
		id: SessionQueuedSubmission["id"],
		controller: AbortController,
		completion: Promise<SessionSendOutcome>
	) => void;
	appendQueuedSubmission: (submission: SessionQueuedSubmission) => void;
	beginSteeringCommit: (id: SessionQueuedSubmission["id"]) => boolean;
	canDrainQueue: () => boolean;
	commitSteeringSubmission: (
		submission: SessionQueuedSubmission
	) => Promise<SessionSteeringAdmission>;
	endSteeringCommit: (id: SessionQueuedSubmission["id"]) => void;
	getExternalization: (
		id: SessionQueuedSubmission["id"]
	) => SessionInputExternalization | undefined;
	getSnapshot: () => LiveSessionSnapshot;
	isClosed: () => boolean;
	isExecutionBusy: () => boolean;
	isExternalizing: (id: SessionQueuedSubmission["id"]) => boolean;
	isQueueDraining: () => boolean;
	isSteeringCommitting: () => boolean;
	isSubmissionBusy: () => boolean;
	removeExternalization: (id: SessionQueuedSubmission["id"]) => void;
	removeQueuedSubmission: (
		id: SessionQueuedSubmission["id"]
	) => SessionQueuedSubmission | undefined;
	replaceInputLanes: (
		queuedSubmissions: readonly SessionQueuedSubmission[],
		steeringMessages: readonly SessionSteeringMessage[]
	) => void;
	replaceQueuedSubmission: (submission: SessionQueuedSubmission) => void;
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
	takeQueuedSubmission: (
		id: SessionQueuedSubmission["id"]
	) => SessionQueuedSubmission | undefined;
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

/** Input-lane policy and queue orchestration; all authoritative transitions return to Agent Session. */
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
		const started = port.takeQueuedSubmission(next.id);
		if (started === undefined) {
			return true;
		}
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
	const drainQueueContents = async (): Promise<void> => {
		while (true) {
			if (port.isClosed() || port.isSteeringCommitting()) {
				break;
			}
			const snapshot = port.getSnapshot();
			const steering = snapshot.steeringMessages[0];
			if (steering !== undefined) {
				if (!(await drainSteeringHead(steering))) {
					break;
				}
				continue;
			}
			const next = snapshot.queuedSubmissions[0];
			if (next === undefined) {
				break;
			}
			if (!(await drainQueuedHead(next))) {
				break;
			}
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
	const removeQueuedSubmission = (
		id: SessionQueuedSubmission["id"]
	): SessionQueuedSubmission | undefined => {
		const removed = port.removeQueuedSubmission(id);
		if (removed !== undefined) {
			releaseQueuedAttachments([removed]);
		}
		return removed;
	};
	const failQueuedSubmissionAttachments = (
		queued: SessionQueuedSubmission
	): SessionSendOutcome => {
		if (removeQueuedSubmission(queued.id) === undefined) {
			return port.isClosed()
				? { rejected: true, reason: SESSION_SHUT_DOWN_ERROR }
				: { rejected: false };
		}
		const reason = port.isClosed()
			? SESSION_SHUT_DOWN_ERROR
			: QUEUED_ATTACHMENT_ERROR;
		port.reportSubmissionFailure(queued.input, queued.messageId, reason);
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
		const stillQueued = port
			.getSnapshot()
			.queuedSubmissions.some((submission) => submission.id === queued.id);
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
		port.replaceQueuedSubmission({ ...queued, input });
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
		port.appendQueuedSubmission(queued);
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
	let steeringTail: Promise<void> = Promise.resolve();
	const deferredRecalls: {
		readonly ids: readonly SessionWaitingMessageId[] | undefined;
		readonly reason: "recall" | "turn-failed";
		readonly resolve: (messages: SessionWaitingMessage[]) => void;
		readonly reject: (reason?: unknown) => void;
	}[] = [];
	const commitQueuedSteering = async (
		queued: SessionQueuedSubmission
	): Promise<SessionSteeringAdmission> => {
		try {
			const externalization = port.getExternalization(queued.id);
			if (externalization !== undefined) {
				const outcome = await externalization.completion;
				if (outcome.rejected) {
					return {
						kind: "rejected",
						messageId: queued.messageId,
						reason: outcome.reason,
						submissionId: queued.submissionId,
					};
				}
			}
			const current = port.getSnapshot().queuedSubmissions[0];
			if (current?.id !== queued.id) {
				return {
					kind: "rejected",
					messageId: queued.messageId,
					reason: "The queued Submission is no longer waiting.",
					submissionId: queued.submissionId,
				};
			}
			return await port.commitSteeringSubmission(current);
		} catch (error) {
			return {
				kind: "rejected",
				messageId: queued.messageId,
				reason: getErrorMessage(error, "Could not commit the Submission."),
				submissionId: queued.submissionId,
			};
		}
	};
	const steer = (): Promise<SessionSteeringAdmission> => {
		const operation = steeringTail.then(
			async (): Promise<SessionSteeringAdmission> => {
				if (port.isClosed()) {
					return { kind: "rejected", reason: SESSION_SHUT_DOWN_ERROR };
				}
				const queued = port.getSnapshot().queuedSubmissions[0];
				if (queued === undefined) {
					return { kind: "empty" };
				}
				if (!port.beginSteeringCommit(queued.id)) {
					return {
						kind: "rejected",
						messageId: queued.messageId,
						reason: "The queued Submission is no longer waiting.",
						submissionId: queued.submissionId,
					};
				}
				try {
					return await commitQueuedSteering(queued);
				} finally {
					try {
						port.endSteeringCommit(queued.id);
					} finally {
						flushDeferredRecalls();
						port.trackBackgroundTask(drainQueuedSubmissions());
					}
				}
			}
		);
		steeringTail = operation.then(
			() => undefined,
			() => undefined
		);
		return operation;
	};
	const recallWaitingMessagesNow = (
		ids: readonly SessionWaitingMessageId[] | undefined,
		reason: "recall" | "turn-failed"
	): SessionWaitingMessage[] => {
		const snapshot = port.getSnapshot();
		const queued = snapshot.queuedSubmissions.filter((submission) =>
			waitingMessageMatches(ids, submission.id, submission.submissionId)
		);
		if (queued.length === 0) {
			return [];
		}
		port.replaceInputLanes(
			snapshot.queuedSubmissions.filter(
				(submission) => !queued.includes(submission)
			),
			snapshot.steeringMessages
		);
		for (const submission of queued) {
			port.getExternalization(submission.id)?.controller.abort();
		}
		releaseQueuedAttachments(queued);
		for (const submission of queued) {
			port.emitSubmissionEvent(recalledSubmissionEvent(submission, reason));
		}
		return queued;
	};
	const flushDeferredRecalls = (): void => {
		for (const recall of deferredRecalls.splice(0)) {
			try {
				recall.resolve(recallWaitingMessagesNow(recall.ids, recall.reason));
			} catch (error) {
				recall.reject(error);
			}
		}
	};
	const recallWaitingMessagesWithReason = (
		ids: readonly SessionWaitingMessageId[] | undefined,
		reason: "recall" | "turn-failed"
	): Promise<SessionWaitingMessage[]> => {
		if (!port.isSteeringCommitting()) {
			return Promise.resolve(recallWaitingMessagesNow(ids, reason));
		}
		const { promise, resolve, reject } =
			Promise.withResolvers<SessionWaitingMessage[]>();
		deferredRecalls.push({ ids, reason, resolve, reject });
		return promise;
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

import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	toSessionMessageId,
} from "@wincode/agent-core";
import { isUndefined, omitUndefined } from "@wincode/runtime-utils";
import {
	type SubmissionId,
	toQueuedSubmissionId,
	toSteeringMessageId,
	toSubmissionId,
} from "@/shared/identifiers";
import { createSessionUserMessage, type SessionFilePart } from "../message";
import type {
	SessionSendInput,
	SessionSendOutcome,
	SessionSubmissionComposition,
} from "../submission-types";
import type {
	AgentSessionPorts,
	SessionExecution,
	SessionQueuedSendInput,
	SessionQueuedSubmission,
	SessionSnapshot,
	SessionSteeringAdmission,
	SessionSteeringMessage,
	SessionSubmissionAdmission,
	SessionSubmissionEvent,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "./types";
import { acceptsSteeringMessages, primaryEntry } from "./utils";

const SESSION_SHUT_DOWN_ERROR = "The session has ended.";
const QUEUED_ATTACHMENT_ERROR = "Attachment data could not be stored.";
const STEERING_ATTACHMENT_ERROR =
	"A Steering Message carries text only: attachments are not accepted.";
const STEERING_SKILL_ERROR =
	"A Steering Message cannot invoke a Skill: it carries text only.";
const STEERING_INVOCATION_ERROR =
	"A Steering Message carries text only: it cannot resend or edit another message.";
const STEERING_INACTIVE_ERROR =
	"An active Agent Turn is required to accept a Steering Message.";

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
		controller: AbortController
	) => void;
	appendQueuedSubmission: (submission: SessionQueuedSubmission) => void;
	appendSteeringMessage: (message: SessionSteeringMessage) => void;
	canDrainQueue: () => boolean;
	getExternalization: (
		id: SessionQueuedSubmission["id"]
	) => AbortController | undefined;
	getSnapshot: () => SessionSnapshot;
	isClosed: () => boolean;
	isExternalizing: (id: SessionQueuedSubmission["id"]) => boolean;
	isQueueDraining: () => boolean;
	isSubmissionBusy: () => boolean;
	removeExternalization: (id: SessionQueuedSubmission["id"]) => void;
	removeQueuedSubmission: (
		id: SessionQueuedSubmission["id"]
	) => SessionQueuedSubmission | undefined;
	replaceInputLanes: (
		queuedSubmissions: SessionQueuedSubmission[],
		steeringMessages: SessionSteeringMessage[]
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
	acceptSteeringMessage: (input: SessionSendInput) => SessionSteeringAdmission;
	drainQueuedSubmissions: () => Promise<void>;
	fallbackSteeringMessages: (turnId?: SessionExecution["turnId"]) => void;
	prompt: (input: SessionSendInput) => Promise<SessionSubmissionAdmission>;
	recallWaitingMessages: (
		ids?: readonly SessionWaitingMessageId[]
	) => SessionWaitingMessage[];
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	steer: (text: string) => SessionSteeringAdmission;
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
	message: SessionWaitingMessage
): SessionSubmissionEvent | undefined => {
	const messageId =
		"messageId" in message ? message.messageId : message.input.messageId;
	const submissionId =
		"submissionId" in message
			? message.submissionId
			: message.input.submissionId;
	if (messageId === undefined || submissionId === undefined) {
		return;
	}
	return {
		kind: "recalled",
		messageId,
		reason: "recall",
		submissionId,
		...omitUndefined({
			turnId:
				"input" in message && message.input.turnId !== undefined
					? message.input.turnId
					: undefined,
		}),
	};
};

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
	const drainQueuedSubmissions = async (): Promise<void> => {
		if (port.isQueueDraining() || port.isClosed() || !port.canDrainQueue()) {
			return;
		}
		port.setQueueDraining(true);
		try {
			while (!port.isClosed()) {
				const next = port.getSnapshot().queuedSubmissions[0];
				if (next === undefined || port.isExternalizing(next.id)) {
					break;
				}
				const started = port.takeQueuedSubmission(next.id);
				if (started === undefined) {
					continue;
				}
				try {
					await port.runSubmission(started.input);
				} catch {
					// A failed turn publishes its own error and cannot strand later work.
				}
				releaseQueuedAttachments([started]);
			}
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
		port.addExternalization(queued.id, attachmentController);
		port.appendQueuedSubmission(queued);
		const pending = finishQueuedSubmissionAttachments(
			queued,
			attachmentController,
			originalAttachmentIds
		);
		return pending.finally(() => {
			port.removeExternalization(queued.id);
			port.trackBackgroundTask(drainQueuedSubmissions());
		});
	};
	const acceptSteeringMessage = (
		input: SessionSendInput
	): SessionSteeringAdmission => {
		const composition: SessionSubmissionComposition = input.composition ?? {
			files: [],
			text: input.userText ?? "",
		};
		if ((input.files ?? composition.files).length > 0) {
			return { rejected: true, reason: STEERING_ATTACHMENT_ERROR };
		}
		if (!isUndefined(input.skill)) {
			return { rejected: true, reason: STEERING_SKILL_ERROR };
		}
		if (!(isUndefined(input.messageId) && isUndefined(input.delegation))) {
			return { rejected: true, reason: STEERING_INVOCATION_ERROR };
		}
		const execution = primaryEntry(port.getSnapshot().executions);
		const submissionId =
			input.submissionId ?? toSubmissionId(`submission-${crypto.randomUUID()}`);
		const messageId =
			input.reservedMessageId ??
			toSessionMessageId(`msg-${crypto.randomUUID()}`);
		const turnId = input.turnId ?? execution?.turnId ?? createAgentTurnId();
		const steering: SessionSteeringMessage = {
			id: toSteeringMessageId(crypto.randomUUID()),
			input: {
				agent: input.agent,
				composition: { ...composition, files: [] },
				messageId,
				model: input.model,
				sessionModel: input.sessionModel,
				submissionId,
				text: input.userText ?? composition.text,
				turnId,
				...omitUndefined({
					resolvedAgent: input.resolvedAgent,
					sessionVariant: input.sessionVariant,
					variant: input.variant,
				}),
			},
		};
		port.appendSteeringMessage(steering);
		return {
			rejected: false,
			disposition: "steering",
			messageId,
			submissionId,
			turnId,
		};
	};
	const fallbackSteeringMessages = (
		turnId?: SessionExecution["turnId"]
	): void => {
		if (port.isClosed()) {
			return;
		}
		const snapshot = port.getSnapshot();
		if (snapshot.steeringMessages.length === 0) {
			return;
		}
		const isOwnedByTurn = (message: SessionSteeringMessage): boolean =>
			turnId === undefined || message.input.turnId === turnId;
		const waiting = snapshot.steeringMessages
			.filter(isOwnedByTurn)
			.map(({ input }) => {
				const messageId =
					input.messageId ?? toSessionMessageId(`msg-${crypto.randomUUID()}`);
				const submissionId =
					input.submissionId ??
					toSubmissionId(`submission-${crypto.randomUUID()}`);
				const nextTurnId = createAgentTurnId();
				return {
					id: toQueuedSubmissionId(crypto.randomUUID()),
					messageId,
					submissionId,
					input: {
						agent: input.agent,
						composition: input.composition,
						files: input.composition.files,
						model: input.model,
						sessionModel: input.sessionModel,
						submissionId,
						reservedMessageId: messageId,
						turnId: nextTurnId,
						userText: input.text,
						...omitUndefined({
							resolvedAgent: input.resolvedAgent,
							sessionVariant: input.sessionVariant,
							variant: input.variant,
						}),
					},
				};
			});
		if (waiting.length > 0) {
			port.replaceInputLanes(
				[...waiting, ...snapshot.queuedSubmissions],
				snapshot.steeringMessages.filter((message) => !isOwnedByTurn(message))
			);
		}
	};
	const recallWaitingMessages = (
		ids?: readonly SessionWaitingMessageId[]
	): SessionWaitingMessage[] => {
		const snapshot = port.getSnapshot();
		const steering = snapshot.steeringMessages.filter((message) =>
			waitingMessageMatches(ids, message.id, message.input.submissionId)
		);
		const queued = snapshot.queuedSubmissions.filter((submission) =>
			waitingMessageMatches(ids, submission.id, submission.submissionId)
		);
		if (steering.length === 0 && queued.length === 0) {
			return [];
		}
		port.replaceInputLanes(
			snapshot.queuedSubmissions.filter(
				(submission) => !queued.includes(submission)
			),
			snapshot.steeringMessages.filter((message) => !steering.includes(message))
		);
		for (const submission of queued) {
			port.getExternalization(submission.id)?.abort();
		}
		releaseQueuedAttachments(queued);
		for (const message of [...steering, ...queued]) {
			const event = recalledSubmissionEvent(message);
			if (event !== undefined) {
				port.emitSubmissionEvent(event);
			}
		}
		return [...steering, ...queued];
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
	const steer = (text: string): SessionSteeringAdmission => {
		if (port.isClosed()) {
			return { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
		}
		const snapshot = port.getSnapshot();
		const execution = primaryEntry(snapshot.executions);
		if (!acceptsSteeringMessages(snapshot) || execution === undefined) {
			return { rejected: true, reason: STEERING_INACTIVE_ERROR };
		}
		return acceptSteeringMessage({
			agent: execution.agent,
			composition: { files: [], text },
			model: execution.model,
			sessionModel: execution.sessionModel,
			userText: text,
			turnId: execution.turnId,
			...omitUndefined({
				sessionVariant: execution.sessionVariant,
				variant: execution.variant,
			}),
		});
	};
	const send = async (input: SessionSendInput): Promise<SessionSendOutcome> => {
		if (port.isClosed()) {
			return { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
		}
		if (acceptsSteeringMessages(port.getSnapshot())) {
			const outcome = acceptSteeringMessage(input);
			return outcome.rejected ? outcome : { rejected: false };
		}
		if (port.isSubmissionBusy()) {
			return await acceptQueuedSubmission(input);
		}
		return await port.runSubmission(input);
	};
	return {
		acceptQueuedSubmission,
		acceptSteeringMessage,
		drainQueuedSubmissions,
		fallbackSteeringMessages,
		prompt,
		recallWaitingMessages,
		send,
		steer,
	};
};

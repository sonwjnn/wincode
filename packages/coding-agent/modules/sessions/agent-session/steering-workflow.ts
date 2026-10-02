import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionRecord,
	toSessionMessageId,
} from "@wincode/agent-core";
import {
	getErrorMessage,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import type { ReadonlyDeep } from "type-fest";
import { createSkillSnapshot, formatSkillUserContext } from "@/modules/skills";
import type { SessionId } from "@/shared/identifiers";
import { logSessionPersistenceFailure } from "@/shared/utils/session-persistence-diagnostics";
import {
	createSessionUserMessage,
	type SessionMessage,
	type SessionMessageMetadata,
	withSubmissionStatus,
} from "../message";
import { buildUserSessionRecord } from "../storage/session-record";
import type { SessionSendInput, SessionSendOutcome } from "../submission-types";
import type {
	AgentSessionPorts,
	LiveSessionSnapshot,
	SessionAttachmentBudget,
	SessionExecution,
	SessionQueuedSubmission,
	SessionSkillCatalog,
	SessionSteeringMessage,
	SessionSteeringStatus,
	SessionSubmissionEvent,
} from "./types";

const SESSION_SHUT_DOWN_ERROR = "The session has ended.";
const STEERING_ATTACHMENT_PREPARATION_ERROR =
	"Steered Submission attachments could not be prepared.";
const STEERING_DELIVERY_CONFIRMATION_ERROR =
	"The Agent Turn ended before confirming the Submission.";

/** One steering delivery the Agent Session holds while its Agent Turn runs. */
export type PendingSteeringDelivery = ReadonlyDeep<{
	execution: SessionExecution;
	message: SessionMessage;
	source: SessionSteeringMessage;
}>;

type SteeringRecordPreparation =
	| ReadonlyDeep<{
			kind: "ready";
			input: SessionSendInput;
			message: SessionMessage;
			record: SessionRecord;
			text: string;
			turnId?: AgentTurnId;
	  }>
	| ReadonlyDeep<{
			kind: "rejected";
			messageId: SessionQueuedSubmission["messageId"];
			reason: string;
			submissionId: SessionQueuedSubmission["submissionId"];
	  }>;

type PreparedSteeringMessage = ReadonlyDeep<{
	skillContext: SessionMessage[];
	source: SessionSteeringMessage;
}>;

type ReadySteeringMessage = PreparedSteeringMessage &
	ReadonlyDeep<{
		hydrated: SessionMessage;
	}>;

type SteeringDeliveryFailure = ReadonlyDeep<{
	reason: string;
	source: SessionSteeringMessage;
}>;

type SteeringBatchPreparation = ReadonlyDeep<{
	failure?: SteeringDeliveryFailure;
	ready: ReadySteeringMessage[];
}>;

type SteeringSkillPreparation =
	| ReadonlyDeep<{ kind: "failed"; reason: string }>
	| ReadonlyDeep<{
			kind: "ready";
			skillContext: SessionMessage[];
	  }>;

type SteeringSkillBatchPreparation = ReadonlyDeep<{
	failure?: SteeringDeliveryFailure;
	prepared: PreparedSteeringMessage[];
}>;

const hydrateSteeringBatch = (
	prepared: readonly PreparedSteeringMessage[],
	budget: SessionAttachmentBudget,
	port: SessionSteeringWorkflowPort,
	signal: AbortSignal
): Promise<SessionMessage[]> =>
	port.attachments.hydrate({
		budget,
		failOnMissingAttachments: true,
		messages: prepared.map(({ source }) => source.message),
		signal,
	});

const readySteeringMessages = (
	prepared: readonly PreparedSteeringMessage[],
	hydrated: readonly SessionMessage[]
): ReadySteeringMessage[] =>
	prepared.flatMap((entry, index) => {
		const message = hydrated[index];
		return message === undefined ? [] : [{ ...entry, hydrated: message }];
	});

const findFirstSteeringAttachmentFailure = async (
	prepared: readonly PreparedSteeringMessage[],
	budget: SessionAttachmentBudget,
	port: SessionSteeringWorkflowPort,
	signal: AbortSignal
): Promise<{ index: number; reason: string } | undefined> => {
	for (const [index, entry] of prepared.entries()) {
		try {
			await hydrateSteeringBatch([entry], budget, port, signal);
		} catch (error) {
			if (signal.aborted) {
				return;
			}
			return {
				index,
				reason: getErrorMessage(error, STEERING_ATTACHMENT_PREPARATION_ERROR),
			};
		}
	}
};

const prepareSteeringPrefix = async (
	prefix: readonly PreparedSteeringMessage[],
	budget: SessionAttachmentBudget,
	port: SessionSteeringWorkflowPort,
	signal: AbortSignal,
	failure: SteeringDeliveryFailure
): Promise<SteeringBatchPreparation> => {
	const first = prefix[0];
	if (first === undefined) {
		return { failure, ready: [] };
	}
	try {
		const hydrated = await hydrateSteeringBatch(prefix, budget, port, signal);
		if (signal.aborted) {
			return { ready: [] };
		}
		const ready = readySteeringMessages(prefix, hydrated);
		return ready.length === prefix.length
			? { failure, ready }
			: {
					failure: {
						reason: STEERING_ATTACHMENT_PREPARATION_ERROR,
						source: first.source,
					},
					ready: [],
				};
	} catch (error) {
		if (signal.aborted) {
			return { ready: [] };
		}
		return {
			failure: {
				reason: getErrorMessage(error, STEERING_ATTACHMENT_PREPARATION_ERROR),
				source: first.source,
			},
			ready: [],
		};
	}
};

const recoverSteeringBatch = async (
	prepared: readonly PreparedSteeringMessage[],
	budget: SessionAttachmentBudget,
	port: SessionSteeringWorkflowPort,
	signal: AbortSignal,
	batchError: unknown
): Promise<SteeringBatchPreparation> => {
	const first = prepared[0];
	if (first === undefined) {
		return { ready: [] };
	}
	const unavailable = await findFirstSteeringAttachmentFailure(
		prepared,
		budget,
		port,
		signal
	);
	if (signal.aborted) {
		return { ready: [] };
	}
	if (unavailable === undefined) {
		return {
			failure: {
				reason: getErrorMessage(
					batchError,
					STEERING_ATTACHMENT_PREPARATION_ERROR
				),
				source: first.source,
			},
			ready: [],
		};
	}
	const failed = prepared[unavailable.index];
	if (failed === undefined) {
		return {
			failure: {
				reason: unavailable.reason,
				source: first.source,
			},
			ready: [],
		};
	}
	return prepareSteeringPrefix(
		prepared.slice(0, unavailable.index),
		budget,
		port,
		signal,
		{ reason: unavailable.reason, source: failed.source }
	);
};

const prepareSteeringBatch = async (
	prepared: readonly PreparedSteeringMessage[],
	execution: SessionExecution,
	port: SessionSteeringWorkflowPort,
	signal: AbortSignal
): Promise<SteeringBatchPreparation> => {
	const first = prepared[0];
	if (first === undefined) {
		return { ready: [] };
	}
	let budget: SessionAttachmentBudget;
	try {
		const settings = await port.resolveCompactionSettings(execution.model);
		budget = {
			maxAttachments: settings.maxMediaAttachments,
			maxBytes: settings.maxMediaBytes,
			maxTokens: settings.maxMediaTokens,
		};
	} catch (error) {
		if (signal.aborted) {
			return { ready: [] };
		}
		return {
			failure: {
				reason: getErrorMessage(error, STEERING_ATTACHMENT_PREPARATION_ERROR),
				source: first.source,
			},
			ready: [],
		};
	}
	try {
		const hydrated = await hydrateSteeringBatch(prepared, budget, port, signal);
		if (signal.aborted) {
			return { ready: [] };
		}
		const ready = readySteeringMessages(prepared, hydrated);
		return ready.length === prepared.length
			? { ready }
			: {
					failure: {
						reason: STEERING_ATTACHMENT_PREPARATION_ERROR,
						source: first.source,
					},
					ready: [],
				};
	} catch (error) {
		return signal.aborted
			? { ready: [] }
			: recoverSteeringBatch(prepared, budget, port, signal, error);
	}
};

const prepareSteeringSkill = async (
	source: SessionSteeringMessage,
	armedSkill: SessionSkillCatalog,
	port: SessionSteeringWorkflowPort
): Promise<SteeringSkillPreparation> => {
	const resolution = await port.skills
		.resolveSkill(source.input.skill, source.message, armedSkill)
		.catch((error: unknown) => ({
			ok: false as const,
			reason: getErrorMessage(
				error,
				"The requested Skill could not be prepared."
			),
		}));
	if (!resolution.ok) {
		return { kind: "failed", reason: resolution.reason };
	}
	if (resolution.skill === undefined) {
		return { kind: "ready", skillContext: [] };
	}
	return {
		kind: "ready",
		skillContext: [
			{
				id: toSessionMessageId(`skill-context-${source.message.id}`),
				parts: [
					{
						text: formatSkillUserContext(resolution.skill),
						type: "text" as const,
					},
				],
				role: "user" as const,
			},
		],
	};
};

const prepareSteeringSkills = async (
	sources: readonly SessionSteeringMessage[],
	armedSkill: SessionSkillCatalog,
	port: SessionSteeringWorkflowPort,
	signal: AbortSignal
): Promise<SteeringSkillBatchPreparation> => {
	const prepared: PreparedSteeringMessage[] = [];
	for (const source of sources) {
		if (source.status !== "pending" || signal.aborted) {
			break;
		}
		const skill = await prepareSteeringSkill(source, armedSkill, port);
		if (signal.aborted) {
			return { prepared: [] };
		}
		if (skill.kind === "failed") {
			return {
				failure: { reason: skill.reason, source },
				prepared,
			};
		}
		prepared.push({ skillContext: skill.skillContext, source });
	}
	return { prepared };
};

/**
 * The Agent Session authority the steering workflow may ask to transition.
 * Delivery bookkeeping maps stay owner-owned (ADR-0032).
 */
export type SessionSteeringWorkflowPort = ReadonlyDeep<{
	attachments: AgentSessionPorts["attachments"];
	/** Drops one Agent Turn's pending-delivery bookkeeping. */
	clearPendingSteering: (turnId: AgentTurnId) => void;
	/** Drops the steering message registered to start one Agent Turn. */
	clearPendingSteeringStart: (turnId: AgentTurnId) => void;
	clearRetryingSteering: (id: SessionSteeringMessage["id"]) => void;
	commitRecord: AgentSessionPorts["commitRecord"];
	emitSubmissionEvent: (event: SessionSubmissionEvent) => void;
	getPendingSteering: (
		turnId: AgentTurnId
	) => readonly PendingSteeringDelivery[] | undefined;
	getSnapshot: () => LiveSessionSnapshot;
	hasPendingSteeringStart: (turnId: AgentTurnId) => boolean;
	hasRetryingSteering: (id: SessionSteeringMessage["id"]) => boolean;
	isClosed: () => boolean;
	markRetryingSteering: (id: SessionSteeringMessage["id"]) => void;
	publish: (changes: Partial<LiveSessionSnapshot>) => void;
	resolveCompactionSettings: AgentSessionPorts["resolveCompactionSettings"];
	resolveFileMentions: AgentSessionPorts["resolveFileMentions"];
	resolveSubmission: AgentSessionPorts["resolveSubmission"];
	runSubmission: (
		input: SessionSendInput,
		options?: { reportFailure?: boolean }
	) => Promise<SessionSendOutcome>;
	sessionId: SessionId;
	setPendingSteering: (
		turnId: AgentTurnId,
		deliveries: PendingSteeringDelivery[]
	) => void;
	setPendingSteeringStart: (
		turnId: AgentTurnId,
		source: SessionSteeringMessage
	) => void;
	skills: AgentSessionPorts["skills"];
	updateSubmissionStatus: AgentSessionPorts["updateSubmissionStatus"];
}>;

export type SessionSteeringWorkflow = ReadonlyDeep<{
	/** Persists the terminal state of the deliveries one Agent Turn held. */
	acknowledge: (
		turnId: AgentTurnId,
		status: "failed" | "processed",
		reason?: string
	) => Promise<void>;
	/** Builds the durable record one promoted Queued Submission becomes. */
	prepareRecord: (
		queued: SessionQueuedSubmission,
		execution: SessionExecution | undefined,
		activeInput: SessionSendInput | undefined
	) => Promise<SteeringRecordPreparation>;
	/** Persists that record; false when the durable write failed. */
	persistRecord: (
		record: SessionRecord,
		input: SessionSendInput
	) => Promise<boolean>;
	/** Runs the oldest committed Submission again after a failure. */
	retryFailedMessage: (
		message: SessionSteeringMessage
	) => Promise<SessionSendOutcome>;
	/** Runs the oldest committed Submission waiting for a turn. */
	runPendingMessage: (
		message: SessionSteeringMessage
	) => Promise<SessionSendOutcome>;
	/** Delivers pending steering at a Model Step boundary. */
	take: (
		execution: SessionExecution,
		armedSkill: SessionSkillCatalog,
		signal: AbortSignal
	) => Promise<SessionMessage[]>;
}>;

/**
 * Steering delivery policy is extracted; delivery records, settlements, and
 * every state transition remain with the Agent Session.
 */
export const createSessionSteeringWorkflow = (
	port: SessionSteeringWorkflowPort
): SessionSteeringWorkflow => {
	const persistSteeringStatus = async (
		source: SessionSteeringMessage,
		status: SessionSteeringStatus,
		reason?: string,
		afterId?: SessionSteeringMessage["id"]
	): Promise<SessionSteeringMessage> => {
		const failure =
			status === "failed"
				? (reason ?? STEERING_DELIVERY_CONFIRMATION_ERROR)
				: undefined;
		await port.updateSubmissionStatus({
			failure,
			messageId: source.message.id,
			recordId: source.recordId,
			status,
			submissionId: source.input.submissionId,
		});
		const message = withSubmissionStatus(source.message, {
			failure,
			status,
		});
		const updated: SessionSteeringMessage = {
			...source,
			message,
			status,
			...omitUndefined({ reason: failure }),
		};
		const snapshot = port.getSnapshot();
		const steeringMessages = snapshot.steeringMessages.filter(
			(entry) => entry.id !== source.id
		);
		if (status === "failed") {
			const previousIndex = isUndefined(afterId)
				? -1
				: steeringMessages.findIndex((entry) => entry.id === afterId);
			steeringMessages.splice(previousIndex + 1, 0, updated);
		}
		port.publish({
			context:
				status === "failed"
					? snapshot.context.filter((entry) => entry.id !== message.id)
					: snapshot.context.map((entry) =>
							entry.id === message.id ? message : entry
						),
			steeringMessages,
			transcript: snapshot.transcript.map((entry) =>
				entry.id === message.id ? message : entry
			),
		});
		return updated;
	};
	const acknowledge = async (
		turnId: AgentTurnId,
		status: "failed" | "processed",
		reason?: string
	): Promise<void> => {
		const pending = port.getPendingSteering(turnId);
		if (pending === undefined) {
			return;
		}
		let previousFailureId: SessionSteeringMessage["id"] | undefined;
		for (const { execution, source } of pending) {
			const failure =
				status === "failed"
					? (reason ?? STEERING_DELIVERY_CONFIRMATION_ERROR)
					: undefined;
			await persistSteeringStatus(source, status, failure, previousFailureId);
			if (status === "failed") {
				previousFailureId = source.id;
			}
			port.emitSubmissionEvent({
				kind: status,
				messageId: source.message.id,
				...omitUndefined({ reason: failure }),
				submissionId: source.input.submissionId,
				turnId: execution.turnId,
			});
		}
		port.clearPendingSteering(turnId);
	};
	const failSteeringDelivery = async (
		execution: SessionExecution,
		source: SessionSteeringMessage,
		reason: string
	): Promise<SessionMessage[]> => {
		await persistSteeringStatus(source, "failed", reason);
		port.emitSubmissionEvent({
			kind: "failed",
			messageId: source.message.id,
			reason,
			submissionId: source.input.submissionId,
			turnId: execution.turnId,
		});
		return [];
	};
	const deliverSteeringMessages = async (
		execution: SessionExecution,
		ready: readonly ReadySteeringMessage[],
		signal: AbortSignal
	): Promise<SessionMessage[]> => {
		const messages: SessionMessage[] = [];
		for (const { hydrated, skillContext, source } of ready) {
			if (port.isClosed() || signal.aborted) {
				return messages;
			}
			const processing = await persistSteeringStatus(source, "processing");
			const pending = port.getPendingSteering(execution.turnId) ?? [];
			const pendingIndex = pending.findIndex(
				(entry) => entry.source.id === processing.id
			);
			const delivery = {
				execution,
				message: processing.message,
				source: processing,
			};
			port.setPendingSteering(
				execution.turnId,
				pendingIndex === -1
					? [...pending, delivery]
					: pending.map((entry, index) =>
							index === pendingIndex ? delivery : entry
						)
			);
			const context = port.getSnapshot().context;
			port.publish({
				context: context.some((message) => message.id === processing.message.id)
					? context.map((message) =>
							message.id === processing.message.id
								? processing.message
								: message
						)
					: [...context, processing.message],
			});
			port.emitSubmissionEvent({
				kind: "delivered",
				messageId: processing.message.id,
				submissionId: processing.input.submissionId,
				turnId: execution.turnId,
			});
			messages.push(...skillContext, hydrated);
		}
		return messages;
	};
	const take = async (
		execution: SessionExecution,
		armedSkill: SessionSkillCatalog,
		signal: AbortSignal
	): Promise<SessionMessage[]> => {
		if (port.isClosed() || !isUndefined(execution.parent)) {
			return [];
		}
		const snapshot = port.getSnapshot();
		const recoveredSources = (
			port.getPendingSteering(execution.turnId) ?? []
		).flatMap(({ source }) => {
			if (
				source.status !== "processing" ||
				snapshot.context.some((message) => message.id === source.message.id) ||
				snapshot.steeringMessages.some(({ id }) => id === source.id)
			) {
				return [];
			}
			return [{ ...source, status: "pending" as const }];
		});
		const sources = [...recoveredSources, ...snapshot.steeringMessages];
		const skills = await prepareSteeringSkills(
			sources,
			armedSkill,
			port,
			signal
		);
		if (port.isClosed() || signal.aborted) {
			return [];
		}
		const preparation = await prepareSteeringBatch(
			skills.prepared,
			execution,
			port,
			signal
		);
		if (port.isClosed() || signal.aborted) {
			return [];
		}
		const messages = await deliverSteeringMessages(
			execution,
			preparation.ready,
			signal
		);
		if (port.isClosed() || signal.aborted) {
			return messages;
		}
		const failure = preparation.failure ?? skills.failure;
		if (failure !== undefined) {
			await failSteeringDelivery(execution, failure.source, failure.reason);
		}
		return messages;
	};
	const persistRecord = async (
		record: SessionRecord,
		input: SessionSendInput
	): Promise<boolean> => {
		if (port.isClosed()) {
			return false;
		}
		try {
			await port.commitRecord({
				record,
				sessionId: port.sessionId,
				sessionModel: input.sessionModel,
				...omitUndefined({
					sessionEffort: input.sessionEffort,
					sessionReasoningMode: input.sessionReasoningMode,
				}),
			});
			return true;
		} catch (error) {
			logSessionPersistenceFailure(
				"Steering message persistence failed",
				error,
				{
					operation: "session.steering",
					phase: "persistence",
					turnId: record.turnId,
				}
			);
			return false;
		}
	};
	const prepareRecord = async (
		queued: SessionQueuedSubmission,
		execution: SessionExecution | undefined,
		activeInput: SessionSendInput | undefined
	): Promise<SteeringRecordPreparation> => {
		if (port.isClosed()) {
			return {
				kind: "rejected",
				messageId: queued.messageId,
				reason: SESSION_SHUT_DOWN_ERROR,
				submissionId: queued.submissionId,
			};
		}
		const turnId =
			execution?.turnId ?? activeInput?.turnId ?? queued.input.turnId;
		const input = port.resolveSubmission({
			...queued.input,
			agent: execution?.agent ?? activeInput?.agent ?? queued.input.agent,
			model: execution?.model ?? activeInput?.model ?? queued.input.model,
			sessionModel:
				execution?.sessionModel ??
				activeInput?.sessionModel ??
				queued.input.sessionModel,
			...omitUndefined({
				effort: execution?.effort ?? activeInput?.effort,
				reasoningMode: execution?.reasoningMode ?? activeInput?.reasoningMode,
				sessionEffort: execution?.sessionEffort ?? activeInput?.sessionEffort,
				sessionReasoningMode:
					execution?.sessionReasoningMode ?? activeInput?.sessionReasoningMode,
			}),
			files: queued.input.composition.files,
			messageId: queued.messageId,
			reservedMessageId: undefined,
			submissionId: queued.submissionId,
			turnId,
			userText: queued.input.userText ?? queued.input.composition.text,
		});
		const text = input.userText ?? queued.input.composition.text;
		const fileMentions = await port.resolveFileMentions(text);
		if (port.isClosed()) {
			return {
				kind: "rejected",
				messageId: queued.messageId,
				reason: SESSION_SHUT_DOWN_ERROR,
				submissionId: queued.submissionId,
			};
		}
		const metadata: SessionMessageMetadata = {
			agent: input.agent,
			model: input.model,
			...omitUndefined({
				effort: input.effort,
				joinedTurnId: execution?.turnId ?? activeInput?.turnId,
				reasoningMode: input.reasoningMode,
				skill: input.skill
					? createSkillSnapshot(input.skill, "explicit")
					: undefined,
				submissionId: queued.submissionId,
				submissionStatus: "pending" as const,
			}),
		};
		const message = createSessionUserMessage(
			text,
			metadata,
			fileMentions,
			queued.input.composition.files,
			queued.messageId
		);
		const record = buildUserSessionRecord({
			agentId: input.agent,
			message,
			model: input.model,
			turnId: turnId ?? createAgentTurnId(),
			...omitUndefined({
				effort: input.effort,
				reasoningMode: input.reasoningMode,
			}),
		});
		return {
			kind: "ready",
			input,
			message,
			record,
			text,
			...omitUndefined({ turnId }),
		};
	};
	const executeCommittedSteering = async (
		source: SessionSteeringMessage
	): Promise<SessionSendOutcome> => {
		const turnId = createAgentTurnId();
		const processing = await persistSteeringStatus(source, "processing");
		const context = port.getSnapshot().context;
		port.publish({
			context: context.some((message) => message.id === processing.message.id)
				? context.map((message) =>
						message.id === processing.message.id ? processing.message : message
					)
				: [...context, processing.message],
		});
		port.setPendingSteeringStart(turnId, processing);
		try {
			const outcome = await port.runSubmission(
				{
					...port.resolveSubmission({
						...processing.input,
						turnId,
					}),
					turnId,
				},
				{ reportFailure: false }
			);
			if (!port.hasPendingSteeringStart(turnId)) {
				return outcome;
			}
			port.clearPendingSteeringStart(turnId);
			const reason =
				outcome.rejected === true
					? outcome.reason
					: "The committed Submission did not start an Agent Turn.";
			await persistSteeringStatus(processing, "failed", reason);
			port.emitSubmissionEvent({
				kind: "failed",
				messageId: source.message.id,
				reason,
				submissionId: source.input.submissionId,
				turnId,
			});
			return { rejected: true, reason };
		} catch (error) {
			if (!port.hasPendingSteeringStart(turnId)) {
				throw error;
			}
			port.clearPendingSteeringStart(turnId);
			const reason = getErrorMessage(
				error,
				"The committed Submission did not start an Agent Turn."
			);
			await persistSteeringStatus(processing, "failed", reason);
			port.emitSubmissionEvent({
				kind: "failed",
				messageId: source.message.id,
				reason,
				submissionId: source.input.submissionId,
				turnId,
			});
			return { rejected: true, reason };
		}
	};
	const runCommittedSteering = async (
		source: SessionSteeringMessage,
		expectedStatus: "failed" | "pending"
	): Promise<SessionSendOutcome> => {
		const closed = port.isClosed();
		if (
			closed ||
			port.getSnapshot().steeringMessages[0]?.id !== source.id ||
			source.status !== expectedStatus
		) {
			return {
				rejected: true,
				reason: closed
					? SESSION_SHUT_DOWN_ERROR
					: "The committed Submission is no longer waiting.",
			};
		}
		const isRetry = expectedStatus === "failed";
		if (isRetry && port.hasRetryingSteering(source.id)) {
			return {
				rejected: true,
				reason: "The committed Submission is already being retried.",
			};
		}
		if (isRetry) {
			port.markRetryingSteering(source.id);
		}
		try {
			return await executeCommittedSteering(source);
		} finally {
			if (isRetry) {
				port.clearRetryingSteering(source.id);
			}
		}
	};
	return {
		acknowledge,
		prepareRecord,
		persistRecord,
		retryFailedMessage: (message) => runCommittedSteering(message, "failed"),
		runPendingMessage: (message) => runCommittedSteering(message, "pending"),
		take,
	};
};

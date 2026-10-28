import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionRecord,
	toSessionMessageId,
} from "@wincode/agent-core";
import { getErrorMessage, omitUndefined } from "@wincode/utils";
import type { ReadonlyDeep } from "type-fest";
import { createSkillSnapshot, formatSkillUserContext } from "@/modules/skills";
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
	port.effects.attachments.hydrate({
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
		const settings = await port.effects.resolveCompactionSettings(
			execution.model
		);
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
	const resolution = await port.effects.skills
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
/** The live steering view one step reads. */
export type SessionSteeringSnapshot = Pick<
	LiveSessionSnapshot,
	"context" | "steeringMessages" | "transcript"
>;

/** Everything the Agent Session holds for steering, frozen at one moment. */
export type SessionSteeringRead = Readonly<{
	/** Deliveries recorded against a live Agent Turn Execution. */
	pending: ReadonlyMap<AgentTurnId, readonly PendingSteeringDelivery[]>;
	/** Steering sources a turn was armed with but has not consumed. */
	pendingStarts: ReadonlyMap<AgentTurnId, SessionSteeringMessage>;
	snapshot: SessionSteeringSnapshot;
}>;

/** The questions a frozen read cannot answer, because they change while a step awaits. */
export type SessionSteeringSignals = Readonly<{
	closed: () => boolean;
}>;

/** A state transition only the Agent Session may apply. */
export type SessionSteeringTransition =
	| { kind: "delivery-cleared"; turnId: AgentTurnId }
	| {
			kind: "delivery-recorded";
			delivery: PendingSteeringDelivery;
			turnId: AgentTurnId;
	  }
	/** Sets one message in the steering view, replacing it by id. */
	| { kind: "message-published"; message: SessionMessage }
	| {
			kind: "start-armed";
			source: SessionSteeringMessage;
			turnId: AgentTurnId;
	  }
	| { kind: "start-consumed"; turnId: AgentTurnId };

/** The work steering hands back to the Agent Session. */
export type SessionSteeringEffects = Readonly<{
	attachments: Pick<AgentSessionPorts["attachments"], "hydrate">;
	commitSteeringRecord: (
		record: SessionRecord,
		input: SessionSendInput
	) => Promise<void>;
	emitSubmissionEvent: (event: SessionSubmissionEvent) => void;
	resolveCompactionSettings: AgentSessionPorts["resolveCompactionSettings"];
	resolveFileMentions: AgentSessionPorts["resolveFileMentions"];
	resolveSubmission: AgentSessionPorts["resolveSubmission"];
	runSteeringRetry: (
		id: SessionSteeringMessage["id"],
		run: () => Promise<SessionSendOutcome>
	) => Promise<SessionSendOutcome | null>;
	runSubmission: (
		input: SessionSendInput,
		options?: { reportFailure?: boolean }
	) => Promise<SessionSendOutcome>;
	skills: Pick<AgentSessionPorts["skills"], "resolveSkill">;
	updateSteeringStatus: (
		source: SessionSteeringMessage,
		updated: SessionSteeringMessage,
		afterId?: SessionSteeringMessage["id"]
	) => Promise<void>;
}>;

/**
 * The Agent Session as steering sees it: what it may read, what it must ask
 * again, the transitions it may propose, and the work it hands back.
 */
export type SessionSteeringWorkflowPort = Readonly<{
	apply: (transition: SessionSteeringTransition) => void;
	effects: SessionSteeringEffects;
	read: () => SessionSteeringRead;
	signals: () => SessionSteeringSignals;
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
	/**
	 * Takes the Steering Message a turn was armed with. The read supplies the
	 * answer the caller branches on; the transition is what clears it.
	 */
	const consumeStart = (
		turnId: AgentTurnId
	): SessionSteeringMessage | undefined => {
		const armed = port.read().pendingStarts.get(turnId);
		if (armed !== undefined) {
			port.apply({ kind: "start-consumed", turnId });
		}
		return armed;
	};
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
		await port.effects.updateSteeringStatus(source, updated, afterId);
		return updated;
	};
	const acknowledge = async (
		turnId: AgentTurnId,
		status: "failed" | "processed",
		reason?: string
	): Promise<void> => {
		const pending = port.read().pending.get(turnId);
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
			port.effects.emitSubmissionEvent({
				kind: status,
				messageId: source.message.id,
				...omitUndefined({ reason: failure }),
				submissionId: source.input.submissionId,
				turnId: execution.turnId,
			});
		}
		port.apply({ kind: "delivery-cleared", turnId });
	};
	const failSteeringDelivery = async (
		execution: SessionExecution,
		source: SessionSteeringMessage,
		reason: string
	): Promise<SessionMessage[]> => {
		await persistSteeringStatus(source, "failed", reason);
		port.effects.emitSubmissionEvent({
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
			if (port.signals().closed() || signal.aborted) {
				return messages;
			}
			const processing = await persistSteeringStatus(source, "processing");
			const delivery = {
				execution,
				message: processing.message,
				source: processing,
			};
			port.apply({
				delivery,
				kind: "delivery-recorded",
				turnId: execution.turnId,
			});
			port.apply({ kind: "message-published", message: processing.message });
			port.effects.emitSubmissionEvent({
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
		if (port.signals().closed()) {
			return [];
		}
		const snapshot = port.read().snapshot;
		const recoveredSources = (
			port.read().pending.get(execution.turnId) ?? []
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
		if (port.signals().closed() || signal.aborted) {
			return [];
		}
		const preparation = await prepareSteeringBatch(
			skills.prepared,
			execution,
			port,
			signal
		);
		if (port.signals().closed() || signal.aborted) {
			return [];
		}
		const messages = await deliverSteeringMessages(
			execution,
			preparation.ready,
			signal
		);
		if (port.signals().closed() || signal.aborted) {
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
		if (port.signals().closed()) {
			return false;
		}
		try {
			await port.effects.commitSteeringRecord(record, input);
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
		if (port.signals().closed()) {
			return {
				kind: "rejected",
				messageId: queued.messageId,
				reason: SESSION_SHUT_DOWN_ERROR,
				submissionId: queued.submissionId,
			};
		}
		const turnId =
			execution?.turnId ?? activeInput?.turnId ?? queued.input.turnId;
		const input = port.effects.resolveSubmission({
			...queued.input,
			agent: execution?.agent ?? activeInput?.agent ?? queued.input.agent,
			model: execution?.model ?? activeInput?.model ?? queued.input.model,
			sessionModel:
				execution?.sessionModel ??
				activeInput?.sessionModel ??
				queued.input.sessionModel,
			...omitUndefined({
				thinkingLevel: execution?.thinkingLevel ?? activeInput?.thinkingLevel,
				sessionThinkingLevel:
					execution?.sessionThinkingLevel ?? activeInput?.sessionThinkingLevel,
			}),
			files: queued.input.composition.files,
			messageId: queued.messageId,
			reservedMessageId: undefined,
			submissionId: queued.submissionId,
			turnId,
			userText: queued.input.userText ?? queued.input.composition.text,
		});
		const text = input.userText ?? queued.input.composition.text;
		const fileMentions = await port.effects.resolveFileMentions(text);
		if (port.signals().closed()) {
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
				thinkingLevel: input.thinkingLevel,
				joinedTurnId: execution?.turnId ?? activeInput?.turnId,
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
				thinkingLevel: input.thinkingLevel,
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
		port.apply({ kind: "message-published", message: processing.message });
		port.apply({ kind: "start-armed", source: processing, turnId });
		try {
			const outcome = await port.effects.runSubmission(
				{
					...port.effects.resolveSubmission({
						...processing.input,
						turnId,
					}),
					turnId,
				},
				{ reportFailure: false }
			);
			if (consumeStart(turnId) === undefined) {
				return outcome;
			}
			const reason =
				outcome.rejected === true
					? outcome.reason
					: "The committed Submission did not start an Agent Turn.";
			await persistSteeringStatus(processing, "failed", reason);
			port.effects.emitSubmissionEvent({
				kind: "failed",
				messageId: source.message.id,
				reason,
				submissionId: source.input.submissionId,
				turnId,
			});
			return { rejected: true, reason };
		} catch (error) {
			if (consumeStart(turnId) === undefined) {
				throw error;
			}
			const reason = getErrorMessage(
				error,
				"The committed Submission did not start an Agent Turn."
			);
			await persistSteeringStatus(processing, "failed", reason);
			port.effects.emitSubmissionEvent({
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
		const closed = port.signals().closed();
		if (
			closed ||
			port.read().snapshot.steeringMessages[0]?.id !== source.id ||
			source.status !== expectedStatus
		) {
			return {
				rejected: true,
				reason: closed
					? SESSION_SHUT_DOWN_ERROR
					: "The committed Submission is no longer waiting.",
			};
		}
		if (expectedStatus === "failed") {
			const outcome = await port.effects.runSteeringRetry(source.id, () =>
				executeCommittedSteering(source)
			);
			return (
				outcome ?? {
					rejected: true,
					reason: "The committed Submission is already being retried.",
				}
			);
		}
		return await executeCommittedSteering(source);
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

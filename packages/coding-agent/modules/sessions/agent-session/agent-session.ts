import {
	type AgentTurnId,
	agentTurnAssistantMessageId,
	createAgentTurnId,
	isSessionToolCallPart,
	type SessionMessageId,
	type SessionRecord,
	type StatefulAgentNextInput,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import { getErrorMessage, isUndefined, omitUndefined } from "@wincode/utils";
import { toSteeringMessageId } from "@/shared/identifiers";
import type { CompactSessionResult } from "../compaction/compaction";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
import {
	isSessionToolPart,
	type SessionMessage,
	type SessionToolPart,
} from "../message";
import { projectSessionRecords } from "../storage/session-record";
import type { SessionSendInput } from "../submission-types";
import { createExecutionRegistry } from "./execution-registry";
import {
	createSessionInputLaneWorkflow,
	type SessionInputExternalization,
	type SessionInputLanePort,
	type SessionInputLaneWorkflow,
} from "./input-lane";
import {
	createSessionMaintenanceWorkflow,
	type SessionMaintenanceCommandState,
	type SessionMaintenancePort,
	type SessionMaintenanceWorkflow,
} from "./maintenance-workflow";
import {
	createSessionSteeringWorkflow,
	type PendingSteeringDelivery,
	type SessionSteeringWorkflow,
} from "./steering-workflow";
import {
	createSubmissionPipeline,
	type SubmissionPipeline,
} from "./submission";
import {
	createSessionSubmissionCommand,
	type SessionActiveSend,
	type SessionSubmissionCommand,
} from "./submission-command";
import { interruptSessionContext } from "./turn";
import type {
	AgentSession,
	AgentSessionInternalPort,
	AgentSessionOptions,
	AgentSessionPorts,
	LiveSessionSnapshot,
	SessionCompactionCommand,
	SessionContinuationOutcome,
	SessionExecution,
	SessionExecutionInput,
	SessionInterruptResult,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionQueuedSubmission,
	SessionSteeringMessage,
	SessionSubmissionEvent,
	SessionViewState,
} from "./types";
import { exposedViewState, hasChanged, latestEntry } from "./utils";

/** The deadline one Agent Turn submission runs with. */
const AGENT_TURN_DEADLINE_MS = 43_200_000;
/** The reason a submission that arrives after the session ended is refused. */
const SHUT_DOWN_SEND_ERROR = "The session has ended.";
type ContinuationContextMessages =
	| {
			kind: "ready";
			anchor: SessionMessage;
			lastMessage: SessionMessage;
	  }
	| { kind: "rejected"; reason: string };

const isCompleteToolCall = (part: SessionToolPart): boolean =>
	part.state === "output-denied" ||
	(part.state === "output-available" && "output" in part) ||
	(part.state === "output-error" &&
		typeof part.errorText === "string" &&
		part.errorText.length > 0);

const findContinuationContextMessages = (
	context: readonly SessionMessage[]
): ContinuationContextMessages => {
	const lastMessage = context.at(-1);
	if (lastMessage === undefined) {
		return {
			kind: "rejected",
			reason: "The Agent Session has no context to continue.",
		};
	}
	const hasIncompleteToolCall = context.some(({ parts }) =>
		parts.some((part) => isSessionToolPart(part) && !isCompleteToolCall(part))
	);
	if (hasIncompleteToolCall) {
		return {
			kind: "rejected",
			reason: "Incomplete Tool Calls cannot be continued.",
		};
	}
	const toolParts = lastMessage.parts.filter(isSessionToolPart);
	const completeToolCall =
		lastMessage.role === "assistant" &&
		toolParts.length > 0 &&
		toolParts.every(isCompleteToolCall);
	if (!(lastMessage.role === "user" || completeToolCall)) {
		return {
			kind: "rejected",
			reason:
				"The Agent Session can only continue from a user message or completed Tool Call.",
		};
	}
	let anchor: SessionMessage | undefined;
	for (let index = context.length - 1; index >= 0; index -= 1) {
		const candidate = context[index];
		if (candidate?.role === "user") {
			anchor = candidate;
			break;
		}
	}
	if (anchor === undefined) {
		return {
			kind: "rejected",
			reason: "The Agent Session has no user message to continue.",
		};
	}
	return { kind: "ready", anchor, lastMessage };
};
type AgentSessionRunState =
	| { readonly phase: "idle" }
	| {
			readonly phase: "interrupted" | "preparing" | "running" | "settling";
	  };
type AgentSessionOperationState = {
	readonly backgroundTasks: Set<Promise<unknown>>;
	readonly compaction: {
		activeCommand: SessionMaintenanceCommandState | undefined;
		readonly requests: Set<Promise<CompactSessionResult>>;
	};
	readonly continuationInputs: WeakSet<SessionSendInput>;
	readonly durableWrites: Set<Promise<void>>;
	readonly transcriptOrder: SessionTranscriptOrder;
	recordCommitTail: Promise<void>;
	readonly events: {
		readonly observers: Set<() => void>;
		readonly submissionEvents: Set<(event: SessionSubmissionEvent) => void>;
	};
	/** Committed Steering Messages a live execution still owes a processing status. */
	readonly steeringLane: {
		readonly pendingSteering: Map<
			AgentTurnId,
			readonly PendingSteeringDelivery[]
		>;
		readonly retryingSteering: Set<SessionSteeringMessage["id"]>;
		readonly pendingSteeringStarts: Map<AgentTurnId, SessionSteeringMessage>;
	};
	readonly lane: {
		activeInput: SessionSendInput | undefined;
		activeTurnId: AgentTurnId | undefined;
		idle: Promise<void>;
		resolveIdle: (() => void) | undefined;
		runs: number;
	};
	readonly queue: {
		drainPhase: "idle" | "draining";
		readonly externalizations: Map<
			SessionQueuedSubmission["id"],
			SessionInputExternalization
		>;
	};
	readonly recovery: {
		readonly activeRuns: Set<symbol>;
		readonly attemptedMessages: Set<SessionMessageId>;
		readonly steeringContinuations: Set<AgentTurnId>;
		epoch: symbol;
	};
	readonly shutdown: {
		closed: boolean;
		controller: AbortController;
		phase: "open" | "closing" | "closed";
		promise: Promise<void> | undefined;
	};
};
type AgentSessionConstructionOptions = AgentSessionOptions & {
	readonly deadlineMs?: number;
};
type SessionTranscriptOrder = {
	readonly committedMessageIds: Set<SessionMessageId>;
	readonly messageIds: SessionMessageId[];
	readonly projectedMessageIdsByRecordMessageId: Map<
		SessionMessageId,
		SessionMessageId
	>;
	readonly toolMessagesByAssistantId: Map<
		SessionMessageId,
		Map<ToolCallId, SessionMessage>
	>;
};

const createSessionTranscriptOrder = (
	messages: readonly SessionMessage[]
): SessionTranscriptOrder => {
	const order: SessionTranscriptOrder = {
		committedMessageIds: new Set(),
		messageIds: [],
		projectedMessageIdsByRecordMessageId: new Map(),
		toolMessagesByAssistantId: new Map(),
	};
	for (const { id } of messages) {
		order.committedMessageIds.add(id);
		order.messageIds.push(id);
	}
	return order;
};

const registerCommittedSessionRecord = (
	order: SessionTranscriptOrder,
	record: SessionRecord,
	assistantMessageId: SessionMessageId = agentTurnAssistantMessageId(
		record.turnId
	)
): SessionMessage[] => {
	const projectedMessages =
		record.model === undefined ? [] : projectSessionRecords([record]);
	let projectedIndex = 0;
	for (const recordMessage of record.messages) {
		if (recordMessage.id === "skill-context") {
			continue;
		}
		const projectedMessage = projectedMessages[projectedIndex];
		projectedIndex += 1;
		const recordMessageId = toSessionMessageId(recordMessage.id);
		const committedMessageId = projectedMessage?.id ?? recordMessageId;
		if (committedMessageId !== recordMessageId) {
			order.projectedMessageIdsByRecordMessageId.set(
				recordMessageId,
				committedMessageId
			);
		}
		if (order.committedMessageIds.has(committedMessageId)) {
			continue;
		}
		order.committedMessageIds.add(committedMessageId);
		order.messageIds.push(committedMessageId);
	}
	if (record.outcome.kind !== "tool") {
		return projectedMessages;
	}
	const toolMessages =
		order.toolMessagesByAssistantId.get(assistantMessageId) ??
		new Map<ToolCallId, SessionMessage>();
	for (const message of projectedMessages) {
		const toolPart = message.parts.find(isSessionToolPart);
		if (toolPart === undefined) {
			continue;
		}
		toolMessages.set(toolPart.toolCallId, message);
	}
	if (toolMessages.size > 0) {
		order.toolMessagesByAssistantId.set(assistantMessageId, toolMessages);
	}
	return projectedMessages;
};

const removeUncommittedToolCallPartsFromMessage = (
	message: SessionMessage,
	assistantMessageId: SessionMessageId,
	toolCallIds: ReadonlySet<ToolCallId>
): SessionMessage | undefined => {
	if (
		message.id !== assistantMessageId ||
		!message.parts.some(
			(part) => isSessionToolPart(part) && toolCallIds.has(part.toolCallId)
		)
	) {
		return message;
	}
	const parts = message.parts.filter(
		(part) => !(isSessionToolPart(part) && toolCallIds.has(part.toolCallId))
	);
	return parts.length === 0 ? undefined : { ...message, parts };
};

const removeUncommittedToolCallParts = (
	messages: readonly SessionMessage[],
	assistantMessageId: SessionMessageId,
	toolCallIds: ReadonlySet<ToolCallId>
): readonly SessionMessage[] => {
	if (toolCallIds.size === 0) {
		return messages;
	}
	let remainingMessages: SessionMessage[] | undefined;
	for (
		let messageIndex = 0;
		messageIndex < messages.length;
		messageIndex += 1
	) {
		const message = messages[messageIndex];
		if (message === undefined) {
			continue;
		}
		const remaining = removeUncommittedToolCallPartsFromMessage(
			message,
			assistantMessageId,
			toolCallIds
		);
		if (remaining === message) {
			remainingMessages?.push(message);
			continue;
		}
		remainingMessages ??= messages.slice(0, messageIndex);
		if (remaining !== undefined) {
			remainingMessages.push(remaining);
		}
	}
	return remainingMessages ?? messages;
};

const removeUncommittedSessionRecordMessages = (
	messages: readonly SessionMessage[],
	record: SessionRecord,
	order: SessionTranscriptOrder,
	assistantMessageId: SessionMessageId = agentTurnAssistantMessageId(
		record.turnId
	)
): readonly SessionMessage[] => {
	const committedToolMessages =
		order.toolMessagesByAssistantId.get(assistantMessageId);
	const uncommittedMessageIds = new Set<SessionMessageId>();
	const uncommittedToolCallIds = new Set<ToolCallId>();
	for (const message of record.messages) {
		if (message.id !== "skill-context") {
			const messageId = toSessionMessageId(message.id);
			if (!order.committedMessageIds.has(messageId)) {
				uncommittedMessageIds.add(messageId);
			}
		}
		for (const part of message.parts) {
			if (
				isSessionToolCallPart(part) &&
				!committedToolMessages?.has(part.toolCallId)
			) {
				uncommittedToolCallIds.add(part.toolCallId);
			}
		}
	}
	const remainingMessages =
		uncommittedMessageIds.size > 0 &&
		messages.some(({ id }) => uncommittedMessageIds.has(id))
			? messages.filter(({ id }) => !uncommittedMessageIds.has(id))
			: messages;
	return removeUncommittedToolCallParts(
		remainingMessages,
		assistantMessageId,
		uncommittedToolCallIds
	);
};

const committedToolMessageForPart = (
	messageId: SessionMessageId,
	part: SessionMessage["parts"][number],
	order: SessionTranscriptOrder
): SessionMessage | undefined =>
	isSessionToolPart(part)
		? order.toolMessagesByAssistantId.get(messageId)?.get(part.toolCallId)
		: undefined;

const projectCommittedToolPartsFromMessage = (
	message: SessionMessage,
	order: SessionTranscriptOrder
): SessionMessage[] | undefined => {
	let remainingParts: SessionMessage["parts"][number][] | undefined;
	let toolMessages: SessionMessage[] | undefined;
	for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
		const part = message.parts[partIndex];
		if (part === undefined) {
			continue;
		}
		const toolMessage = committedToolMessageForPart(message.id, part, order);
		if (toolMessage === undefined) {
			remainingParts?.push(part);
			continue;
		}
		remainingParts ??= message.parts.slice(0, partIndex);
		if (toolMessages === undefined) {
			toolMessages = [];
		}
		toolMessages.push(toolMessage);
	}
	if (toolMessages === undefined) {
		return;
	}
	if (remainingParts !== undefined && remainingParts.length > 0) {
		toolMessages.unshift({ ...message, parts: remainingParts });
	}
	return toolMessages;
};

const canonicalizeCommittedMessages = (
	messages: readonly SessionMessage[],
	order: SessionTranscriptOrder
): readonly SessionMessage[] => {
	let canonical: SessionMessage[] | undefined;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message === undefined) {
			continue;
		}
		const canonicalId = order.projectedMessageIdsByRecordMessageId.get(
			message.id
		);
		if (canonicalId === undefined || canonicalId === message.id) {
			canonical?.push(message);
			continue;
		}
		canonical ??= messages.slice(0, index);
		canonical.push({ ...message, id: canonicalId });
	}
	return canonical ?? messages;
};

const projectCommittedToolMessages = (
	messages: readonly SessionMessage[],
	order: SessionTranscriptOrder
): readonly SessionMessage[] => {
	let projected: SessionMessage[] | undefined;
	for (
		let messageIndex = 0;
		messageIndex < messages.length;
		messageIndex += 1
	) {
		const message = messages[messageIndex];
		if (message === undefined) {
			continue;
		}
		const projectedMessage = projectCommittedToolPartsFromMessage(
			message,
			order
		);
		if (projectedMessage === undefined) {
			projected?.push(message);
			continue;
		}
		projected ??= messages.slice(0, messageIndex);
		projected.push(...projectedMessage);
	}
	return canonicalizeCommittedMessages(projected ?? messages, order);
};
const appendMissingCommittedRecordMessages = (
	messages: readonly SessionMessage[],
	committedMessages: readonly SessionMessage[]
): readonly SessionMessage[] => {
	let next: SessionMessage[] | undefined;
	for (const committedMessage of committedMessages) {
		if ((next ?? messages).some(({ id }) => id === committedMessage.id)) {
			continue;
		}
		next ??= [...messages];
		next.push(committedMessage);
	}
	return next ?? messages;
};

const committedMessagesInStoredOrder = (
	messages: readonly SessionMessage[],
	order: SessionTranscriptOrder
): SessionMessage[] => {
	const messagesById = new Map<SessionMessage["id"], SessionMessage>();
	for (const message of messages) {
		messagesById.set(message.id, message);
	}
	const ordered: SessionMessage[] = [];
	for (const id of order.messageIds) {
		const message = messagesById.get(id);
		if (message !== undefined) {
			ordered.push(message);
		}
	}
	return ordered;
};

const orderSessionTranscript = (
	messages: readonly SessionMessage[],
	order: SessionTranscriptOrder
): readonly SessionMessage[] => {
	if (messages.length < 2) {
		return messages;
	}
	const orderedCommittedMessages = committedMessagesInStoredOrder(
		messages,
		order
	);
	if (orderedCommittedMessages.length < 2) {
		return messages;
	}
	let nextCommittedIndex = 0;
	let needsReorder = false;
	for (const message of messages) {
		if (!order.committedMessageIds.has(message.id)) {
			continue;
		}
		const orderedMessage = orderedCommittedMessages[nextCommittedIndex];
		nextCommittedIndex += 1;
		if (orderedMessage !== message) {
			needsReorder = true;
			break;
		}
	}
	if (!needsReorder) {
		return messages;
	}
	const ordered = [...messages];
	nextCommittedIndex = 0;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message === undefined || !order.committedMessageIds.has(message.id)) {
			continue;
		}
		const orderedMessage = orderedCommittedMessages[nextCommittedIndex];
		nextCommittedIndex += 1;
		if (orderedMessage !== undefined) {
			ordered[index] = orderedMessage;
		}
	}
	return ordered;
};

/**
 * Mints the identity of one overflow-recovery retention epoch. Every attempt
 * begun under an epoch stops being current once a later epoch replaces it.
 */
const nextRecoveryEpoch = (): symbol => Symbol("recovery-epoch");

/**
 * The single owner of one session's live state and the only writer to it.
 * Observers read a Session Snapshot and never write; the Agent Session replaces
 * it instead of mutating it.
 */
export class AgentSessionImpl implements AgentSession {
	readonly cancel: AgentSession["cancel"];
	readonly cancelCompaction: AgentSession["cancelCompaction"];
	readonly compact: AgentSession["compact"];
	readonly continue: AgentSession["continue"];
	readonly getSnapshot: AgentSession["getSnapshot"];
	readonly interrupt: AgentSession["interrupt"];
	readonly interruptAll: AgentSession["interruptAll"];
	readonly internalPort: AgentSessionInternalPort;
	readonly onSubmissionEvent: AgentSession["onSubmissionEvent"];
	readonly prompt: AgentSession["prompt"];
	readonly recallWaitingMessages: AgentSession["recallWaitingMessages"];
	readonly send: AgentSession["send"];
	readonly steer: AgentSession["steer"];
	readonly subscribe: AgentSession["subscribe"];
	#activeSend: SessionActiveSend | undefined;
	readonly #operationState: AgentSessionOperationState;
	#state: LiveSessionSnapshot;
	#runState: AgentSessionRunState = { phase: "idle" };

	constructor({
		deadlineMs = AGENT_TURN_DEADLINE_MS,
		initialCompactions = [],
		initialAgent,
		initialContext,
		initialSessionModel,
		initialSessionThinkingLevel,
		initialSteeringMessages = [],
		initialTranscript,
		ports,
		sessionId,
	}: AgentSessionConstructionOptions) {
		if (!Number.isInteger(deadlineMs) || deadlineMs < 0) {
			throw new Error("Session send deadline must be a non-negative integer.");
		}
		this.#state = {
			catalogDiagnostic: null,
			compactions: [...initialCompactions],
			compactionError: null,
			context: [...(initialContext ?? initialTranscript)],
			error: null,
			executions: [],
			isCompacting: false,
			queuedSubmissions: [...ports.inputScheduler.getQueuedSubmissions()],
			steeringMessages: [...initialSteeringMessages],
			transcript: [...initialTranscript],
			transcriptRevision: 0,
			turnActive: false,
			viewState: undefined,
		};
		this.#operationState = {
			backgroundTasks: new Set(),
			compaction: { activeCommand: undefined, requests: new Set() },
			continuationInputs: new WeakSet(),
			durableWrites: new Set(),
			transcriptOrder: createSessionTranscriptOrder(initialTranscript),
			recordCommitTail: Promise.resolve(),
			events: {
				observers: new Set(),
				submissionEvents: new Set(),
			},
			steeringLane: {
				pendingSteering: new Map(),
				pendingSteeringStarts: new Map(),
				retryingSteering: new Set(),
			},
			lane: {
				activeInput: undefined,
				activeTurnId: undefined,
				idle: Promise.resolve(),
				resolveIdle: undefined,
				runs: 0,
			},
			queue: {
				externalizations: new Map(),
				drainPhase: "idle",
			},
			recovery: {
				activeRuns: new Set(),
				attemptedMessages: new Set(),
				steeringContinuations: new Set(),
				epoch: nextRecoveryEpoch(),
			},
			shutdown: {
				controller: new AbortController(),
				get closed() {
					return this.phase !== "open";
				},
				phase: "open",
				promise: undefined,
			},
		};
		const sessionState = this.#operationState;
		const executionRegistry = createExecutionRegistry({
			isLive: (turnId) =>
				this.#state.executions.some((execution) => execution.turnId === turnId),
		});
		const getAssistantMessageId = (turnId: AgentTurnId): SessionMessageId =>
			this.#state.executions.find((execution) => execution.turnId === turnId)
				?.assistantId ??
			executionRegistry.assistantIdFor(turnId) ??
			agentTurnAssistantMessageId(turnId);
		const emitSubmissionEvent = (event: SessionSubmissionEvent): void => {
			for (const listener of [...sessionState.events.submissionEvents]) {
				try {
					listener(event);
				} catch {
					// Observers cannot change Agent Session authority.
				}
			}
		};
		const commitRecord: AgentSessionPorts["commitRecord"] = (input) => {
			if (sessionState.shutdown.closed) {
				return Promise.resolve();
			}
			const assistantMessageId =
				input.record.outcome.kind === "tool"
					? getAssistantMessageId(input.record.turnId)
					: undefined;
			const write = sessionState.recordCommitTail
				.then(() => ports.commitRecord(input))
				.then(
					() => {
						const committedMessages = registerCommittedSessionRecord(
							sessionState.transcriptOrder,
							input.record,
							assistantMessageId
						);
						const projectedTranscript = projectCommittedToolMessages(
							this.#state.transcript,
							sessionState.transcriptOrder
						);
						const transcript = orderSessionTranscript(
							appendMissingCommittedRecordMessages(
								projectedTranscript,
								committedMessages
							),
							sessionState.transcriptOrder
						);
						if (transcript !== this.#state.transcript) {
							publish({ transcript });
						}
					},
					(error) => {
						const transcript = removeUncommittedSessionRecordMessages(
							this.#state.transcript,
							input.record,
							sessionState.transcriptOrder,
							assistantMessageId
						);
						if (transcript !== this.#state.transcript) {
							publish({ transcript });
						}
						throw error;
					}
				);
			sessionState.recordCommitTail = write.then(
				() => undefined,
				() => undefined
			);
			sessionState.durableWrites.add(write);
			void write.then(
				() => sessionState.durableWrites.delete(write),
				() => sessionState.durableWrites.delete(write)
			);
			return write;
		};
		const updateSubmissionStatus: AgentSessionPorts["updateSubmissionStatus"] =
			(input) => {
				const write = ports.updateSubmissionStatus(input);
				sessionState.durableWrites.add(write);
				void write.then(
					() => sessionState.durableWrites.delete(write),
					() => sessionState.durableWrites.delete(write)
				);
				return write;
			};
		/**
		 * Late runtime callbacks can still settle after cancellation. They must not
		 * reach the durable store once the Agent Session has lost authority.
		 */
		const agentSessionPorts: AgentSessionPorts = {
			...ports,
			commitRecord,
			updateSubmissionStatus,
		};
		const publish = (changes: Partial<LiveSessionSnapshot>): void => {
			const compactionPhase = sessionState.compaction.activeCommand?.phase;
			const scheduledSubmissions = ports.inputScheduler.getQueuedSubmissions();
			const currentSubmissions = this.#state.queuedSubmissions;
			const queuedSubmissionsUnchanged =
				currentSubmissions.length === scheduledSubmissions.length &&
				currentSubmissions.every(
					(submission, index) => submission === scheduledSubmissions[index]
				);
			const projectedChanges: Partial<LiveSessionSnapshot> = {
				...changes,
				queuedSubmissions: queuedSubmissionsUnchanged
					? currentSubmissions
					: [...scheduledSubmissions],
				isCompacting:
					compactionPhase === "preparing" || compactionPhase === "running",
				turnActive:
					this.#runState.phase !== "idle" &&
					this.#runState.phase !== "interrupted",
			};
			if (!hasChanged(this.#state, projectedChanges)) {
				return;
			}
			const transcript = projectedChanges.transcript;
			const transcriptChanged =
				transcript !== undefined &&
				(this.#state.transcript.length !== transcript.length ||
					this.#state.transcript.some(
						(message, index) => message !== transcript[index]
					));
			const nextChanges =
				transcriptChanged === true
					? {
							...projectedChanges,
							transcriptRevision: (this.#state.transcriptRevision ?? 0) + 1,
						}
					: projectedChanges;
			this.#state = { ...this.#state, ...nextChanges };
			for (const listener of sessionState.events.observers) {
				try {
					listener();
				} catch {
					// An observer cannot change session state.
				}
			}
		};
		const setRunPhase = (phase: "preparing" | "running" | "settling"): void => {
			if (this.#runState.phase === "interrupted" && phase === "settling") {
				return;
			}
			this.#runState = { phase };
			publish({});
		};
		const applyContext = (messages: readonly SessionMessage[]): void => {
			publish({ context: [...messages] });
		};
		const mergeTranscript = (
			messages: readonly SessionMessage[]
		): readonly SessionMessage[] => {
			const merged = [...this.#state.transcript];
			let hasNewCommittedMessage = false;
			for (const message of projectCommittedToolMessages(
				messages,
				sessionState.transcriptOrder
			)) {
				if (isCompactionSummaryMessage(message)) {
					continue;
				}
				const index = merged.findIndex(({ id }) => id === message.id);
				if (index === -1) {
					merged.push(message);
					if (
						sessionState.transcriptOrder.committedMessageIds.has(message.id)
					) {
						hasNewCommittedMessage = true;
					}
				} else {
					merged[index] = message;
				}
			}
			const transcript = hasNewCommittedMessage
				? orderSessionTranscript(merged, sessionState.transcriptOrder)
				: merged;
			publish({ transcript });
			return transcript;
		};
		const recordCompaction = (entry: SessionCompaction): void => {
			if (this.#state.compactions.some(({ id }) => id === entry.id)) {
				return;
			}
			publish({ compactions: [...this.#state.compactions, entry] });
		};
		const setCompactionError = (error: Error | null): void => {
			if (sessionState.shutdown.closed) {
				return;
			}
			publish({ compactionError: error });
		};
		let maintenance: SessionMaintenanceWorkflow;
		const compact = (
			command: SessionCompactionCommand
		): Promise<CompactSessionResult> => maintenance.compact(command);
		const cancelCompactionCommand = (): void => maintenance.cancelCompaction();
		const settleCompaction = (): Promise<Error | null> =>
			maintenance.settleCompaction();
		const recoverOverflow = async (
			command: SessionOverflowRecoveryCommand
		): Promise<SessionOverflowRecoveryOutcome> => {
			if (sessionState.steeringLane.pendingSteering.has(command.turnId)) {
				sessionState.recovery.steeringContinuations.add(command.turnId);
			}
			try {
				return await maintenance.recoverOverflow(command);
			} finally {
				sessionState.recovery.steeringContinuations.delete(command.turnId);
			}
		};

		/** Ends an execution and wakes everything waiting for it to end. */
		const endExecution = (
			turnId: AgentTurnId,
			retainForSettlement = false
		): void => {
			executionRegistry.end(
				turnId,
				retainForSettlement
					? this.#state.executions.find(
							(candidate) => candidate.turnId === turnId
						)
					: undefined
			);
			const executions = this.#state.executions.filter(
				(execution) => execution.turnId !== turnId
			);
			if (executions.length === this.#state.executions.length) {
				return;
			}
			publish({ executions, viewState: exposedViewState(executions) });
		};

		const beginExecution = (input: SessionExecutionInput): SessionExecution => {
			const turnId = input.turnId ?? createAgentTurnId();
			const execution: SessionExecution = {
				agent: input.agent,
				assistantId: agentTurnAssistantMessageId(turnId),
				model: input.model,
				...omitUndefined({
					sessionThinkingLevel: input.sessionThinkingLevel,
					submissionId: input.submissionId,
					thinkingLevel: input.thinkingLevel,
				}),
				sessionModel: input.sessionModel,
				sourceUserMessageId: input.sourceUserMessageId ?? null,
				startedAt: input.startedAt,
				turnId,
			};
			const initialSteering =
				sessionState.steeringLane.pendingSteeringStarts.get(turnId);
			if (initialSteering !== undefined) {
				sessionState.steeringLane.pendingSteeringStarts.delete(turnId);
			}
			const pendingSteering: PendingSteeringDelivery[] = [];
			if (initialSteering !== undefined) {
				pendingSteering.push({
					execution,
					message: initialSteering.message,
					source: initialSteering,
				});
			}
			for (const sourceTurnId of sessionState.recovery.steeringContinuations) {
				const previous =
					sessionState.steeringLane.pendingSteering.get(sourceTurnId);
				if (previous === undefined) {
					continue;
				}
				sessionState.steeringLane.pendingSteering.delete(sourceTurnId);
				sessionState.recovery.steeringContinuations.delete(sourceTurnId);
				for (const { message, source } of previous) {
					pendingSteering.push({ execution, message, source });
				}
				break;
			}
			if (pendingSteering.length > 0) {
				sessionState.steeringLane.pendingSteering.set(turnId, pendingSteering);
			}
			publish({ executions: [...this.#state.executions, execution] });
			return execution;
		};
		const setExecutionViewState = (
			turnId: AgentTurnId,
			viewState: SessionViewState
		): void => {
			if (
				!this.#state.executions.some((execution) => execution.turnId === turnId)
			) {
				return;
			}
			const executions = this.#state.executions.map((execution) =>
				execution.turnId === turnId ? { ...execution, viewState } : execution
			);
			publish({ executions, viewState: exposedViewState(executions) });
		};
		/** The most recently active Agent Turn execution in this Session. */
		const latestExecution = (): SessionExecution | undefined =>
			latestEntry(this.#state.executions);
		/**
		 * Presents an interrupted turn: the target message keeps the interrupted
		 * Tool Call the abort named and the context is sanitized around it.
		 */
		const interruptLatestAssistantMessage = (
			preserveToolCallId?: ToolCallId
		): void => {
			const next = interruptSessionContext(
				this.#state.context,
				latestExecution(),
				preserveToolCallId
			);
			if (isUndefined(next)) {
				return;
			}
			applyContext(next);
			mergeTranscript(next);
		};

		const waitForDurableWrites = async (): Promise<void> => {
			let firstFailure: { reason: unknown } | undefined;
			while (sessionState.durableWrites.size > 0) {
				const results = await Promise.allSettled([
					...sessionState.durableWrites,
				]);
				for (const result of results) {
					if (result.status === "rejected" && firstFailure === undefined) {
						firstFailure = { reason: result.reason };
					}
				}
			}
			if (firstFailure !== undefined) {
				throw firstFailure.reason;
			}
		};
		const waitForCompactions = async (): Promise<void> => {
			while (sessionState.compaction.requests.size > 0) {
				await Promise.all(
					[...sessionState.compaction.requests].map(async (compaction) => {
						try {
							await compaction;
						} catch {
							// A shutdown-triggered compaction cancellation is expected.
						}
					})
				);
			}
		};
		const trackBackgroundTask = (task: Promise<unknown>): void => {
			sessionState.backgroundTasks.add(task);
			void (async () => {
				try {
					await task;
				} catch {
					// Maintenance failures are surfaced by their own error path.
				} finally {
					sessionState.backgroundTasks.delete(task);
				}
			})();
		};
		const waitForBackgroundTasks = async (): Promise<void> => {
			while (sessionState.backgroundTasks.size > 0) {
				await Promise.all(
					[...sessionState.backgroundTasks].map(async (task) => {
						try {
							await task;
						} catch {
							// A shutdown-triggered maintenance cancellation is expected.
						}
					})
				);
			}
		};
		let inputLane: SessionInputLaneWorkflow;
		/** A transition for a command the Session already replaced must not resurrect it. */
		const isSupersededCommand = (
			command: SessionMaintenanceCommandState
		): boolean =>
			sessionState.compaction.activeCommand?.promise !== command.promise;
		const maintenancePort: SessionMaintenancePort = {
			apply: (transition) => {
				switch (transition.kind) {
					case "compaction-started": {
						sessionState.compaction.activeCommand = transition.command;
						publish({});
						return;
					}
					case "compaction-phase":
					case "compaction-settled": {
						if (isSupersededCommand(transition.command)) {
							return;
						}
						// The command the caller holds stays frozen; the Session owns the live phase.
						sessionState.compaction.activeCommand =
							transition.kind === "compaction-phase"
								? { ...transition.command, phase: transition.phase }
								: undefined;
						publish({});
						return;
					}
					case "compaction-applied": {
						applyContext(transition.result.activeMessages);
						recordCompaction(transition.result.entry);
						setCompactionError(null);
						return;
					}
					case "compaction-failed": {
						setCompactionError(transition.error);
						return;
					}
					case "compaction-request-tracked": {
						const { request } = transition;
						sessionState.compaction.requests.add(request);
						void request.then(
							() => sessionState.compaction.requests.delete(request),
							() => sessionState.compaction.requests.delete(request)
						);
						return;
					}
					case "recovery-begun": {
						sessionState.recovery.attemptedMessages.add(transition.messageId);
						return;
					}
					case "recovery-released": {
						sessionState.recovery.attemptedMessages.delete(
							transition.messageId
						);
						return;
					}
					default: {
						// Defensive: the union is exhaustive, so TypeScript narrows this to never.
						throw new Error("Unhandled Session maintenance transition.");
					}
				}
			},
			compaction: ports.compaction,
			effects: {
				drainQueueInBackground: () => {
					trackBackgroundTask(inputLane.drainQueuedSubmissions());
				},
				resolveCompactionSettings: async (model) => {
					const settings = await ports.resolveCompactionSettings(model);
					return {
						...omitUndefined({
							contextWindowOverrideTokens: settings.contextWindowOverrideTokens,
							summary: settings.summary,
						}),
						compactionOverheadTokens: ports.turnRunner.requestOverheadTokens(),
						enabled: settings.enabled,
						keepRecentTokens: settings.keepRecentTokens,
						maxMediaAttachments: settings.maxMediaAttachments,
						maxMediaBytes: settings.maxMediaBytes,
						maxMediaTokens: settings.maxMediaTokens,
						modelContextLimit: settings.modelContextLimit,
						reserveTokens: settings.reserveTokens,
						thresholdTokens: settings.thresholdTokens,
					};
				},
				runTrackedRecovery: (run) => {
					const runId = Symbol("overflow-recovery-run");
					sessionState.recovery.activeRuns.add(runId);
					const recovery = run();
					const settleRecovery = (): void => {
						sessionState.recovery.activeRuns.delete(runId);
						trackBackgroundTask(inputLane.drainQueuedSubmissions());
					};
					void recovery.then(settleRecovery, settleRecovery);
					return recovery;
				},
				waitForExecutionEnd: executionRegistry.waitForEnd,
				withTranscriptOverlay: mergeTranscript,
			},
			read: () => ({
				activeCompaction: sessionState.compaction.activeCommand,
				context: this.#state.context,
				recovery: {
					// Copied so a snapshot taken before an await cannot change under its reader.
					attempted: new Set(sessionState.recovery.attemptedMessages),
					epoch: sessionState.recovery.epoch,
				},
				sessionId,
				shutdownSignal: sessionState.shutdown.controller.signal,
				transcript: this.#state.transcript,
			}),
			signals: () => ({
				closed: () => sessionState.shutdown.closed,
				recoveryCurrent: (epoch) =>
					!sessionState.shutdown.closed &&
					sessionState.recovery.epoch === epoch,
			}),
		};
		maintenance = createSessionMaintenanceWorkflow(maintenancePort);

		let pipeline: SubmissionPipeline;
		let steering: SessionSteeringWorkflow;
		let submissionCommand: SessionSubmissionCommand;
		pipeline = createSubmissionPipeline({
			applyContext,
			beginExecution,
			getAssistantMessageId,
			getError: () => this.#state.error,
			finishModelStep: (turnId, record) => {
				const assistantId = getAssistantMessageId(turnId);
				const text =
					record === undefined ? undefined : projectSessionRecords([record])[0];
				const canonical = projectCommittedToolMessages(
					this.#state.context,
					sessionState.transcriptOrder
				);
				const next = canonical.flatMap((message) => {
					if (message.id !== assistantId) {
						return [message];
					}
					return text === undefined ? [] : [text];
				});
				applyContext(
					orderSessionTranscript(next, sessionState.transcriptOrder)
				);
				if (text === undefined) {
					publish({
						transcript: this.#state.transcript.filter(
							(message) => message.id !== assistantId
						),
					});
				} else {
					mergeTranscript([text]);
				}
				const nextAssistantId = toSessionMessageId(
					`assistant-${crypto.randomUUID()}`
				);
				executionRegistry.reassignAssistantId(turnId, nextAssistantId);
				publish({
					executions: this.#state.executions.map((execution) =>
						execution.turnId === turnId
							? { ...execution, assistantId: nextAssistantId }
							: execution
					),
				});
			},
			compact,
			continueContext: (input, onExecutionStarted) =>
				submissionCommand.continueContext(input, onExecutionStarted),
			endExecution,
			acknowledgeSteeringMessages: (turnId, status, failure) =>
				steering.acknowledge(turnId, status, failure),
			recallFailedTurnMessages: (_turnId) =>
				inputLane.recallFailedTurnMessages(),
			getContext: () => this.#state.context,
			getTranscript: () => this.#state.transcript,
			isShutDown: () => sessionState.shutdown.closed,
			isContextContinuation: (input) =>
				sessionState.continuationInputs.has(input),
			mergeTranscript,
			ports: agentSessionPorts,
			recoverOverflow,
			sessionId,
			setCatalogDiagnostic: (diagnostic) =>
				publish({ catalogDiagnostic: diagnostic }),
			setCompactionError,
			setError: (error) => publish({ error }),
			setExecutionViewState,
			setRunPhase,
			settleCompaction,
			trackBackgroundTask,
			takeSteeringMessages: (execution, armedSkill, signal) =>
				steering.take(execution, armedSkill, signal),
		});

		const beginSubmission = (
			input: SessionSendInput
		): {
			messageId: SessionMessageId | undefined;
			ownsTurnReservation: boolean;
		} => {
			if (sessionState.lane.runs === 0) {
				sessionState.lane.activeInput = input;
				const idle = Promise.withResolvers<void>();
				sessionState.lane.idle = idle.promise;
				sessionState.lane.resolveIdle = idle.resolve;
			}
			sessionState.lane.runs += 1;
			if (sessionState.lane.runs === 1) {
				setRunPhase("preparing");
			}
			const ownsTurnReservation =
				sessionState.lane.activeTurnId === undefined &&
				input.turnId !== undefined;
			if (ownsTurnReservation) {
				sessionState.lane.activeTurnId = input.turnId;
			}
			const messageId = input.messageId ?? input.reservedMessageId;
			if (input.submissionId !== undefined && messageId !== undefined) {
				emitSubmissionEvent({
					kind: "started",
					messageId,
					submissionId: input.submissionId,
					...omitUndefined({ turnId: input.turnId }),
				});
			}
			return { messageId, ownsTurnReservation };
		};
		const reportSubmissionFailure = (
			input: SessionSendInput,
			messageId: SessionMessageId | undefined,
			reason: string
		): void => {
			if (input.submissionId === undefined || messageId === undefined) {
				return;
			}
			emitSubmissionEvent({
				kind: "failed",
				messageId,
				reason,
				submissionId: input.submissionId,
				...omitUndefined({ turnId: input.turnId }),
			});
		};
		const finishSubmission = (
			input: SessionSendInput,
			ownsTurnReservation: boolean
		): void => {
			if (
				ownsTurnReservation &&
				sessionState.lane.activeTurnId === input.turnId
			) {
				sessionState.lane.activeTurnId = undefined;
			}
			sessionState.lane.runs -= 1;
			if (sessionState.lane.runs === 0) {
				sessionState.lane.activeInput = undefined;
			}
			if (sessionState.lane.runs === 0) {
				sessionState.lane.resolveIdle?.();
				sessionState.lane.resolveIdle = undefined;
			}
			if (sessionState.lane.runs === 0) {
				this.#runState = { phase: "idle" };
				publish({});
			}
			trackBackgroundTask(inputLane.drainQueuedSubmissions());
		};
		const waitForCurrentActiveSend = async (): Promise<void> => {
			while (this.#activeSend !== undefined) {
				await this.#activeSend.promise.catch(() => undefined);
			}
		};
		submissionCommand = createSessionSubmissionCommand({
			runInSubmissionLane: async (input, options, run) => {
				const { messageId, ownsTurnReservation } = beginSubmission(input);
				try {
					const outcome = await run();
					if (outcome.rejected && options.reportFailure !== false) {
						reportSubmissionFailure(input, messageId, outcome.reason);
					}
					return outcome;
				} catch (error) {
					if (options.reportFailure !== false) {
						reportSubmissionFailure(
							input,
							messageId,
							getErrorMessage(error, "The Submission failed.")
						);
					}
					throw error;
				} finally {
					finishSubmission(input, ownsTurnReservation);
				}
			},
			cancelCompaction: cancelCompactionCommand,
			deadlineMs,
			getActiveSend: () => this.#activeSend,
			prepareContinuation: async (input) => {
				if (sessionState.shutdown.closed) {
					return { kind: "closed" };
				}
				await waitForCurrentActiveSend();
				while (sessionState.lane.runs > 0) {
					await sessionState.lane.idle;
				}
				if (sessionState.shutdown.closed) {
					return { kind: "closed" };
				}
				if (
					this.#state.turnActive ||
					this.#state.isCompacting ||
					sessionState.compaction.activeCommand !== undefined
				) {
					return { kind: "busy" };
				}
				const continuationInput = {
					...input,
					turnId: input.turnId ?? createAgentTurnId(),
				};
				sessionState.continuationInputs.add(continuationInput);
				return { kind: "ready", input: continuationInput };
			},
			isClosed: () => sessionState.shutdown.closed,
			pipelineSend: (input, signal, onExecutionStarted) =>
				pipeline.send(input, signal, onExecutionStarted),
			publishError: (error) => publish({ error }),
			setActiveSend: (active) => {
				this.#activeSend = active;
			},
			waitForActiveSend: waitForCurrentActiveSend,
		});
		const abortActiveSend = submissionCommand.abortActiveSend;
		const runSubmission = submissionCommand.runSubmission;
		const waitForActiveSend = submissionCommand.waitForActiveSend;
		const commitSteeringSubmission: SessionInputLanePort["commitSteeringSubmission"] =
			async (queued) => {
				const prepared = await steering.prepareRecord(
					queued,
					latestExecution(),
					sessionState.lane.activeInput
				);
				if (prepared.kind === "rejected") {
					return { kind: "rejected", admission: prepared };
				}
				const { input, message, record, text, turnId } = prepared;
				if (!(await steering.persistRecord(record, input))) {
					return {
						kind: "rejected",
						admission: {
							kind: "rejected",
							messageId: queued.messageId,
							reason: "Could not durably commit the Submission.",
							submissionId: queued.submissionId,
						},
					};
				}
				const steeringInput = {
					...input,
					composition: queued.input.composition,
					files: queued.input.composition.files,
					messageId: queued.messageId,
					submissionId: queued.submissionId,
					turnId,
					userText: text,
				};
				const steeringMessage: SessionSteeringMessage = {
					id: toSteeringMessageId(crypto.randomUUID()),
					input: steeringInput,
					message,
					recordId: record.id,
					status: "pending",
				};
				return {
					kind: "committed",
					admission: {
						kind: "steered",
						messageId: queued.messageId,
						submissionId: queued.submissionId,
						...omitUndefined({ turnId }),
					},
					steeringMessage,
				};
			};
		const completeSteeringSubmission: SessionInputLanePort["completeSteeringSubmission"] =
			(queued, receipt) => {
				if (receipt.kind !== "committed") {
					return;
				}
				const { admission, steeringMessage } = receipt;
				const attachmentIds = steeringMessage.input.composition.files.flatMap(
					({ attachmentId }) =>
						attachmentId === undefined ? [] : [attachmentId]
				);
				publish({
					context: this.#state.context,
					steeringMessages: [...this.#state.steeringMessages, steeringMessage],
					transcript: appendMissingCommittedRecordMessages(
						this.#state.transcript,
						[steeringMessage.message]
					),
				});
				if (attachmentIds.length > 0) {
					ports.attachments.release(attachmentIds);
				}
				emitSubmissionEvent({
					kind: "steered",
					messageId: queued.messageId,
					submissionId: queued.submissionId,
					...omitUndefined({ turnId: admission.turnId }),
				});
			};
		steering = createSessionSteeringWorkflow({
			apply: (transition) => {
				switch (transition.kind) {
					case "delivery-cleared": {
						sessionState.steeringLane.pendingSteering.delete(transition.turnId);
						return;
					}
					case "delivery-recorded": {
						const { delivery, turnId } = transition;
						const current =
							sessionState.steeringLane.pendingSteering.get(turnId) ?? [];
						const index = current.findIndex(
							(entry) => entry.source.id === delivery.source.id
						);
						sessionState.steeringLane.pendingSteering.set(
							turnId,
							index === -1
								? [...current, delivery]
								: current.map((entry, position) =>
										position === index ? delivery : entry
									)
						);
						return;
					}
					case "message-published": {
						const { message } = transition;
						const context = this.#state.context;
						publish({
							context: context.some((entry) => entry.id === message.id)
								? context.map((entry) =>
										entry.id === message.id ? message : entry
									)
								: [...context, message],
						});
						return;
					}
					case "start-armed": {
						sessionState.steeringLane.pendingSteeringStarts.set(
							transition.turnId,
							transition.source
						);
						return;
					}
					case "start-consumed": {
						sessionState.steeringLane.pendingSteeringStarts.delete(
							transition.turnId
						);
						return;
					}
					default: {
						// Defensive: the union is exhaustive, so TypeScript narrows this to never.
						throw new Error("Unhandled Session steering transition.");
					}
				}
			},
			effects: {
				attachments: { hydrate: ports.attachments.hydrate },
				commitSteeringRecord: (record, input) =>
					commitRecord({
						record,
						sessionId,
						sessionModel: input.sessionModel,
						...omitUndefined({
							sessionThinkingLevel: input.sessionThinkingLevel,
						}),
					}),
				emitSubmissionEvent,
				resolveCompactionSettings: ports.resolveCompactionSettings,
				resolveFileMentions: ports.resolveFileMentions,
				resolveSubmission: ports.resolveSubmission,
				runSteeringRetry: async (id, run) => {
					if (sessionState.steeringLane.retryingSteering.has(id)) {
						return null;
					}
					sessionState.steeringLane.retryingSteering.add(id);
					try {
						return await run();
					} finally {
						sessionState.steeringLane.retryingSteering.delete(id);
					}
				},
				runSubmission,
				skills: { resolveSkill: ports.skills.resolveSkill },
				updateSteeringStatus: async (source, updated, afterId) => {
					await updateSubmissionStatus({
						failure: updated.reason,
						messageId: source.message.id,
						recordId: source.recordId,
						status: updated.status,
						submissionId: source.input.submissionId,
					});
					const snapshot = this.#state;
					const steeringMessages = snapshot.steeringMessages.filter(
						(entry) => entry.id !== source.id
					);
					if (updated.status === "failed") {
						const previousIndex =
							afterId === undefined
								? -1
								: steeringMessages.findIndex((entry) => entry.id === afterId);
						steeringMessages.splice(previousIndex + 1, 0, updated);
					}
					publish({
						context:
							updated.status === "failed"
								? snapshot.context.filter(
										(entry) => entry.id !== updated.message.id
									)
								: snapshot.context.map((entry) =>
										entry.id === updated.message.id ? updated.message : entry
									),
						steeringMessages,
						transcript: snapshot.transcript.map((entry) =>
							entry.id === updated.message.id ? updated.message : entry
						),
					});
				},
			},
			read: () => ({
				pending: new Map(sessionState.steeringLane.pendingSteering),
				pendingStarts: new Map(sessionState.steeringLane.pendingSteeringStarts),
				snapshot: {
					context: this.#state.context,
					steeringMessages: this.#state.steeringMessages,
					transcript: this.#state.transcript,
				},
			}),
			signals: () => ({
				closed: () => sessionState.shutdown.closed,
			}),
		});
		const getInputLaneState = () => ({
			canDrain:
				sessionState.lane.runs === 0 &&
				!this.#state.turnActive &&
				!this.#state.isCompacting &&
				sessionState.compaction.activeCommand === undefined &&
				sessionState.recovery.activeRuns.size === 0 &&
				!ports.inputScheduler.hasPendingSubmissionTransition(),
			closed: sessionState.shutdown.closed,
			executionBusy:
				sessionState.lane.runs > 0 ||
				this.#state.turnActive ||
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined ||
				sessionState.recovery.activeRuns.size > 0,
			queueDraining: sessionState.queue.drainPhase === "draining",
			submissionBusy:
				sessionState.lane.runs > 0 ||
				sessionState.queue.drainPhase === "draining" ||
				this.#state.turnActive ||
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined ||
				sessionState.recovery.activeRuns.size > 0 ||
				sessionState.queue.externalizations.size > 0 ||
				ports.inputScheduler.getQueuedSubmissions().length > 0 ||
				this.#state.steeringMessages.length > 0,
		});
		const inputLanePort: SessionInputLanePort = {
			addExternalization: (id, controller, completion) => {
				sessionState.queue.externalizations.set(id, { completion, controller });
			},
			getLaneState: getInputLaneState,
			commitSteeringSubmission,
			completeSteeringSubmission,
			emitSubmissionEvent,
			externalizeAttachments: (messages, signal) =>
				ports.attachments.externalize(messages, signal),
			getExternalization: (id) => sessionState.queue.externalizations.get(id),
			getSteeringMessages: () => this.#state.steeringMessages,
			inputScheduler: ports.inputScheduler,
			assertSubmissionSelection: (input) =>
				ports.assertProviderModelSelection(ports.resolveSubmission(input)),
			publishQueueChange: () => publish({}),
			removeExternalization: (id) => {
				sessionState.queue.externalizations.delete(id);
			},
			reportSubmissionFailure,
			retainAttachments: (attachmentIds) =>
				ports.attachments.retain(attachmentIds),
			releaseAttachments: (attachmentIds) =>
				ports.attachments.release(attachmentIds),
			runSubmission,
			runSteeringMessage: (message) => steering.runPendingMessage(message),
			retrySteeringMessage: (message) => steering.retryFailedMessage(message),
			setQueueDraining: (draining) => {
				sessionState.queue.drainPhase = draining ? "draining" : "idle";
			},
			trackBackgroundTask,
		};
		inputLane = createSessionInputLaneWorkflow(inputLanePort);
		/**
		 * Interrupts local Agent Session authority immediately while the provider may
		 * still be physically unwinding. The execution signal fences every callback.
		 */
		const interruptActiveWork = (
			preserveToolCallId?: ToolCallId
		): Promise<void> => {
			sessionState.recovery.epoch = nextRecoveryEpoch();
			this.#runState = { phase: "interrupted" };
			publish({});
			abortActiveSend("interrupted");
			interruptLatestAssistantMessage(preserveToolCallId);
			for (const execution of [...this.#state.executions]) {
				endExecution(execution.turnId, true);
			}
			return Promise.resolve();
		};
		const createContextContinuationInput = (
			anchor: SessionMessage,
			lastMessage: SessionMessage
		):
			| {
					kind: "ready";
					input: SessionSendInput;
					turnId: AgentTurnId;
			  }
			| { kind: "rejected"; reason: string } => {
			const agent =
				lastMessage.metadata?.agent ?? anchor.metadata?.agent ?? initialAgent;
			if (isUndefined(agent)) {
				return {
					kind: "rejected",
					reason: "The Agent selection is unavailable.",
				};
			}
			const model =
				lastMessage.metadata?.model ??
				anchor.metadata?.model ??
				initialSessionModel;
			if (isUndefined(model)) {
				return {
					kind: "rejected",
					reason: "The Model selection is unavailable.",
				};
			}
			const turnId = createAgentTurnId();
			const sessionSelection = {
				thinkingLevel:
					initialSessionThinkingLevel ?? anchor.metadata?.thinkingLevel,
			};
			let messageThinkingLevel = sessionSelection.thinkingLevel;
			if (anchor.metadata?.thinkingLevel !== undefined) {
				messageThinkingLevel = anchor.metadata.thinkingLevel;
			}
			if (lastMessage.metadata?.thinkingLevel !== undefined) {
				messageThinkingLevel = lastMessage.metadata.thinkingLevel;
			}
			const input: SessionSendInput = {
				agent,
				messageId: anchor.id,
				model,
				sessionModel: initialSessionModel ?? anchor.metadata?.model ?? model,
				turnId,
				...omitUndefined({
					sessionThinkingLevel: sessionSelection.thinkingLevel,
					thinkingLevel: messageThinkingLevel,
				}),
			};
			return { kind: "ready", input, turnId };
		};
		const startScheduledInput = (
			nextInput: StatefulAgentNextInput
		): SessionContinuationOutcome | undefined => {
			if (nextInput === "steering") {
				const steering = this.#state.steeringMessages[0];
				if (steering === undefined || steering.status !== "pending") {
					return {
						kind: "rejected",
						reason:
							steering?.reason ??
							"A committed Submission failed; retry it before continuing.",
					};
				}
				trackBackgroundTask(inputLane.drainQueuedSubmissions());
				return {
					kind: "started-submission",
					messageId: steering.message.id,
					submissionId: steering.input.submissionId,
					...omitUndefined({ turnId: steering.input.turnId }),
				};
			}
			if (nextInput === "submission") {
				const waiting = ports.inputScheduler.getQueuedSubmissions()[0];
				if (waiting === undefined) {
					return {
						kind: "rejected",
						reason: "No Queued Submission is available.",
					};
				}
				trackBackgroundTask(inputLane.drainQueuedSubmissions());
				return {
					kind: "started-submission",
					messageId: waiting.messageId,
					submissionId: waiting.submissionId,
					...omitUndefined({ turnId: waiting.input.turnId }),
				};
			}
		};
		const continueSession = (): SessionContinuationOutcome => {
			if (sessionState.shutdown.closed) {
				return { kind: "rejected", reason: SHUT_DOWN_SEND_ERROR };
			}
			if (
				sessionState.lane.runs > 0 ||
				sessionState.queue.drainPhase === "draining" ||
				ports.inputScheduler.hasPendingSubmissionTransition() ||
				this.#state.turnActive ||
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined ||
				sessionState.recovery.activeRuns.size > 0 ||
				sessionState.queue.externalizations.size > 0
			) {
				return {
					kind: "rejected",
					reason: "The Agent Session is busy.",
				};
			}
			const scheduledInput = startScheduledInput(
				ports.inputScheduler.selectNextInput({
					hasSteeringMessages: this.#state.steeringMessages.length > 0,
				})
			);
			if (scheduledInput !== undefined) {
				return scheduledInput;
			}
			const messages = findContinuationContextMessages(this.#state.context);
			if (messages.kind === "rejected") {
				return messages;
			}
			const continuation = createContextContinuationInput(
				messages.anchor,
				messages.lastMessage
			);
			if (continuation.kind === "rejected") {
				return continuation;
			}
			sessionState.continuationInputs.add(continuation.input);
			void runSubmission(continuation.input).catch(() => undefined);
			return { kind: "resumed", turnId: continuation.turnId };
		};
		const interruptAll = async (): Promise<SessionInterruptResult> => {
			const hasCompaction =
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined;
			const hasTurn =
				this.#state.turnActive ||
				sessionState.lane.runs > 0 ||
				this.#state.executions.length > 0 ||
				sessionState.recovery.activeRuns.size > 0;
			let kind: SessionInterruptResult["kind"] = "none";
			if (hasCompaction) {
				kind = "compaction";
			} else if (hasTurn) {
				kind = "turn";
			}
			if (hasCompaction) {
				cancelCompactionCommand();
				if (!hasTurn) {
					sessionState.recovery.epoch = nextRecoveryEpoch();
				}
			}
			const pauseWrite = hasTurn ? interruptActiveWork() : Promise.resolve();
			const recall = inputLane.recallWaitingMessages();
			trackBackgroundTask(recall);
			const recalled = await recall;
			await pauseWrite;
			return { kind, recalled };
		};
		const hasPendingWork = (): boolean =>
			sessionState.lane.runs > 0 ||
			sessionState.queue.drainPhase === "draining" ||
			sessionState.compaction.activeCommand !== undefined ||
			sessionState.compaction.requests.size > 0 ||
			sessionState.durableWrites.size > 0 ||
			sessionState.backgroundTasks.size > 0 ||
			sessionState.recovery.activeRuns.size > 0 ||
			sessionState.queue.externalizations.size > 0 ||
			ports.inputScheduler.hasPendingSubmissionTransition() ||
			ports.inputScheduler.getQueuedSubmissions().length > 0 ||
			this.#state.turnActive ||
			this.#state.isCompacting ||
			this.#state.executions.length > 0;
		const shutdown = (): Promise<void> => {
			if (sessionState.shutdown.promise !== undefined) {
				return sessionState.shutdown.promise;
			}
			sessionState.shutdown.phase = "closing";
			sessionState.shutdown.controller.abort();
			for (const {
				controller,
			} of sessionState.queue.externalizations.values()) {
				controller.abort();
			}
			// Whatever was waiting is dropped with the session: its attachment
			// holds end and nothing it held is ever run.
			trackBackgroundTask(inputLane.recallWaitingMessages());
			abortActiveSend("cancelled");
			const compaction = sessionState.compaction.activeCommand?.promise;
			const completion = (async () => {
				const activeSendSettled = waitForActiveSend();
				const compactionSettled = (async (): Promise<void> => {
					if (compaction === undefined) {
						return;
					}
					try {
						await compaction;
					} catch {
						// A shutdown-triggered compaction cancellation is expected.
					}
				})();
				await activeSendSettled;
				await compactionSettled;
				await waitForBackgroundTasks();
				await waitForCompactions();
				await waitForDurableWrites();
			})();
			sessionState.shutdown.promise = completion.finally(() => {
				sessionState.shutdown.phase = "closed";
			});
			return sessionState.shutdown.promise;
		};

		this.internalPort = {
			beginExecution,
			commitRecord,
			endExecution,
			hasPendingWork,
			setExecutionViewState,
			shutdown,
		};
		this.continue = () => continueSession();
		this.cancel = () => {
			sessionState.recovery.epoch = nextRecoveryEpoch();
			abortActiveSend("cancelled");
		};
		this.cancelCompaction = async () => {
			if (
				sessionState.compaction.activeCommand !== undefined ||
				this.#state.isCompacting ||
				sessionState.recovery.activeRuns.size > 0
			) {
				sessionState.recovery.epoch = nextRecoveryEpoch();
			}
			cancelCompactionCommand();
			const recall = inputLane.recallWaitingMessages();
			trackBackgroundTask(recall);
			return await recall;
		};
		this.compact = compact;
		this.getSnapshot = () => this.#state;
		this.interrupt = async (preserveToolCallId) => {
			const pauseWrite = interruptActiveWork(preserveToolCallId);
			const recall = inputLane.recallWaitingMessages();
			trackBackgroundTask(recall);
			const recalled = await recall;
			await pauseWrite;
			return recalled;
		};
		this.interruptAll = interruptAll;
		this.recallWaitingMessages = inputLane.recallWaitingMessages;
		this.prompt = (input) => inputLane.prompt(input);
		this.onSubmissionEvent = (listener) => {
			sessionState.events.submissionEvents.add(listener);
			return () => sessionState.events.submissionEvents.delete(listener);
		};
		this.send = (input) => inputLane.send(input);
		this.steer = inputLane.steer;
		this.subscribe = (listener) => {
			sessionState.events.observers.add(listener);
			return () => sessionState.events.observers.delete(listener);
		};
	}
}

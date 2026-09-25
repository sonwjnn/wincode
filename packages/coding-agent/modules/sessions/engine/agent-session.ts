import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import { isError, isUndefined, omitUndefined } from "@wincode/runtime-utils";
import type { CompactSessionResult } from "../compaction/compaction";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
import {
	createSessionUserMessage,
	isSessionToolPart,
	type SessionMessage,
	type SessionToolPart,
} from "../message";
import { buildUserSessionRecord } from "../storage/session-record";
import type { SessionSendInput } from "../submission-types";
import { createSessionApprovalWorkflow } from "./approval-workflow";
import {
	createSessionInputLaneWorkflow,
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
	SessionApprovalOutcome,
	SessionCompactionCommand,
	SessionContinuationOutcome,
	SessionExecution,
	SessionExecutionInput,
	SessionInterruptResult,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionQueuedSubmission,
	SessionSnapshot,
	SessionSubmissionEvent,
	SessionViewState,
} from "./types";
import { exposedViewState, hasChanged, primaryEntry } from "./utils";

/** The deadline one Agent Turn submission runs with. */
const AGENT_TURN_DEADLINE_MS = 43_200_000;
/** The maximum time local shutdown waits for abort-resistant work to settle. */
const SESSION_SHUTDOWN_WAIT_TIMEOUT_MS = 5000;
const waitForShutdownWork = async (work: Promise<void>): Promise<void> => {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = Promise.withResolvers<void>();
	timeout = setTimeout(deadline.resolve, SESSION_SHUTDOWN_WAIT_TIMEOUT_MS);
	try {
		await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timeout);
	}
};

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
	readonly approvals: {
		nextId: number;
		readonly settlements: Map<
			string,
			(outcome: SessionApprovalOutcome) => void
		>;
		abortTurn: (toolCallId?: ToolCallId) => void;
	};
	readonly backgroundTasks: Set<Promise<unknown>>;
	readonly compaction: {
		activeCommand: SessionMaintenanceCommandState | undefined;
		readonly requests: Set<Promise<CompactSessionResult>>;
	};
	readonly continuationInputs: WeakSet<SessionSendInput>;
	readonly durableWrites: Set<Promise<void>>;
	readonly events: {
		readonly observers: Set<() => void>;
		readonly submissionEvents: Set<(event: SessionSubmissionEvent) => void>;
	};
	readonly executions: {
		readonly endWaiters: Map<AgentTurnId, (() => void)[]>;
	};
	readonly lane: {
		activeTurnId: AgentTurnId | undefined;
		idle: Promise<void>;
		resolveIdle: (() => void) | undefined;
		runs: number;
	};
	readonly queue: {
		drainPhase: "idle" | "draining";
		readonly externalizations: Map<
			SessionQueuedSubmission["id"],
			AbortController
		>;
	};
	readonly recovery: {
		readonly activeRuns: Set<symbol>;
		readonly attemptedMessages: Set<SessionMessageId>;
		generation: number;
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
	readonly respondToApproval: AgentSession["respondToApproval"];
	readonly send: AgentSession["send"];
	readonly steer: AgentSession["steer"];
	readonly subscribe: AgentSession["subscribe"];
	#activeSend: SessionActiveSend | undefined;
	readonly #operationState: AgentSessionOperationState;
	#state: SessionSnapshot;
	#runState: AgentSessionRunState = { phase: "idle" };

	constructor({
		deadlineMs = AGENT_TURN_DEADLINE_MS,
		initialCompactions = [],
		initialAgent,
		initialContext,
		initialSessionModel,
		initialSessionVariant,
		initialTranscript,
		ports,
		sessionId,
	}: AgentSessionConstructionOptions) {
		if (!Number.isInteger(deadlineMs) || deadlineMs < 0) {
			throw new Error("Session send deadline must be a non-negative integer.");
		}
		this.#state = {
			approvals: [],
			catalogDiagnostic: null,
			compactions: [...initialCompactions],
			compactionError: null,
			context: [...(initialContext ?? initialTranscript)],
			error: null,
			executions: [],
			isCompacting: false,
			queuedSubmissions: [],
			steeringMessages: [],
			transcript: [...initialTranscript],
			transcriptRevision: 0,
			turnActive: false,
			viewState: undefined,
		};
		this.#operationState = {
			approvals: {
				abortTurn: () => undefined,
				nextId: 0,
				settlements: new Map(),
			},
			backgroundTasks: new Set(),
			compaction: { activeCommand: undefined, requests: new Set() },
			continuationInputs: new WeakSet(),
			durableWrites: new Set(),
			events: {
				observers: new Set(),
				submissionEvents: new Set(),
			},
			executions: { endWaiters: new Map() },
			lane: {
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
				generation: 0,
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
			const write = ports.commitRecord(input);
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
		const agentSessionPorts: AgentSessionPorts = { ...ports, commitRecord };
		const publish = (changes: Partial<SessionSnapshot>): void => {
			const compactionPhase = sessionState.compaction.activeCommand?.phase;
			const projectedChanges: Partial<SessionSnapshot> = {
				...changes,
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
		const approvals = createSessionApprovalWorkflow({
			abortTurn: (toolCallId) => sessionState.approvals.abortTurn(toolCallId),
			allocateSessionApprovalId: () =>
				`session-${sessionState.approvals.nextId++}`,
			applyApprovals: (approvals) => publish({ approvals }),
			getSettlement: (id) => sessionState.approvals.settlements.get(id),
			getSnapshot: () => this.#state,
			isClosed: () => sessionState.shutdown.closed,
			removeSettlement: (id) => {
				sessionState.approvals.settlements.delete(id);
			},
			saveSettlement: (id, resolve) => {
				sessionState.approvals.settlements.set(id, resolve);
			},
		});
		const settleApproval = approvals.settle;
		const requestApproval = approvals.request;
		const closeApprovals = approvals.close;
		const applyContext = (messages: readonly SessionMessage[]): void => {
			publish({ context: [...messages] });
		};
		const mergeTranscript = (
			messages: readonly SessionMessage[]
		): readonly SessionMessage[] => {
			const merged = [...this.#state.transcript];
			for (const message of messages) {
				if (isCompactionSummaryMessage(message)) {
					continue;
				}
				const index = merged.findIndex(({ id }) => id === message.id);
				if (index === -1) {
					merged.push(message);
				} else {
					merged[index] = message;
				}
			}
			publish({ transcript: merged });
			return merged;
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
		const waitForExecutionEnd = (turnId: AgentTurnId): Promise<void> => {
			if (
				!this.#state.executions.some((execution) => execution.turnId === turnId)
			) {
				return Promise.resolve();
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			const waiters = sessionState.executions.endWaiters.get(turnId);
			if (isUndefined(waiters)) {
				sessionState.executions.endWaiters.set(turnId, [resolve]);
			} else {
				waiters.push(resolve);
			}
			return promise;
		};
		let maintenance: SessionMaintenanceWorkflow;
		const compact = (
			command: SessionCompactionCommand
		): Promise<CompactSessionResult> => maintenance.compact(command);
		const cancelCompactionCommand = (): void => maintenance.cancelCompaction();
		const settleCompaction = (): Promise<Error | null> =>
			maintenance.settleCompaction();
		const recoverOverflow = (
			command: SessionOverflowRecoveryCommand
		): Promise<SessionOverflowRecoveryOutcome> =>
			maintenance.recoverOverflow(command);

		/** Ends an execution and wakes everything waiting for it to end. */
		const endExecution = (turnId: AgentTurnId): void => {
			const waiters = sessionState.executions.endWaiters.get(turnId);
			if (!isUndefined(waiters)) {
				sessionState.executions.endWaiters.delete(turnId);
				for (const resolveEnd of waiters) {
					resolveEnd();
				}
			}
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
				assistantId: toSessionMessageId(`assistant-${turnId}`),
				model: input.model,
				...omitUndefined({
					parent: input.parent,
					sessionVariant: input.sessionVariant,
					submissionId: input.submissionId,
					variant: input.variant,
				}),
				sessionModel: input.sessionModel,
				sourceUserMessageId: input.sourceUserMessageId ?? null,
				startedAt: input.startedAt,
				turnId,
			};
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
		/**
		 * The Agent Turn execution the session's own sends run as: the newest
		 * execution that is not a delegated Subagent, so an interrupt reaches the
		 * turn the user started rather than a child it spawned.
		 */
		const primaryExecution = (): SessionExecution | undefined =>
			primaryEntry(this.#state.executions);
		/**
		 * Presents an interrupted turn: the target message keeps the interrupted
		 * Tool Call the abort named and the context is sanitized around it.
		 */
		const interruptLatestAssistantMessage = (
			preserveToolCallId?: ToolCallId
		): void => {
			const next = interruptSessionContext(
				this.#state.context,
				primaryExecution(),
				preserveToolCallId
			);
			if (isUndefined(next)) {
				return;
			}
			applyContext(next);
			mergeTranscript(next);
		};

		/**
		 * Delivers the Steering Lane into the running Agent Turn: the lane is
		 * popped and every message becomes a Session Record at this moment, so the
		 * delivery point and the commit point are the same event. The message joins
		 * the Session Context and the Session Transcript, and its metadata names
		 * the Agent Turn it joined rather than moving the anchor Overflow Recovery
		 * and retry walk.
		 */
		const takeSteeringMessages = (
			execution: SessionExecution
		): SessionMessage[] => {
			if (
				sessionState.shutdown.closed ||
				!isUndefined(execution.parent) ||
				this.#state.steeringMessages.length === 0
			) {
				return [];
			}
			const taken = this.#state.steeringMessages;
			publish({ steeringMessages: [] });
			// The message joins the turn it was sent to, so it records the Agent and
			// Model Target that turn is already running with: a correction made
			// mid-turn cannot switch a model under the user.
			const delivered = taken.map(({ input }) =>
				createSessionUserMessage(
					input.text,
					{
						agent: execution.agent,
						joinedTurnId: execution.turnId,
						model: execution.model,
						...omitUndefined({ variant: execution.variant }),
					},
					[],
					[],
					input.messageId
				)
			);
			applyContext([...this.#state.context, ...delivered]);
			mergeTranscript(delivered);
			for (const [index, message] of delivered.entries()) {
				const source = taken[index];
				if (
					source !== undefined &&
					source.input.messageId !== undefined &&
					source.input.submissionId !== undefined
				) {
					emitSubmissionEvent({
						kind: "delivered",
						messageId: source.input.messageId,
						submissionId: source.input.submissionId,
						turnId: execution.turnId,
					});
				}
				commitSteeringRecord(execution, message);
			}
			return delivered;
		};
		/**
		 * Writes the Session Record of one delivered Steering Message. The write is
		 * started at the delivery point and its failure is published, so a durable
		 * commit that cannot land never rolls the delivered message back out of the
		 * turn it already joined.
		 */
		const commitSteeringRecord = (
			execution: SessionExecution,
			message: SessionMessage
		): void => {
			const write = agentSessionPorts
				.commitRecord({
					record: buildUserSessionRecord({
						agentId: execution.agent,
						message,
						model: execution.model,
						turnId: execution.turnId,
						...omitUndefined({ variant: execution.variant }),
					}),
					sessionId,
					sessionModel: execution.sessionModel,
					...omitUndefined({ sessionVariant: execution.sessionVariant }),
				})
				.catch((error: unknown) => {
					publish({
						error: isError(error)
							? error
							: new Error("Could not save the Steering Message."),
					});
				});
			sessionState.durableWrites.add(write);
			void write.then(
				() => sessionState.durableWrites.delete(write),
				() => sessionState.durableWrites.delete(write)
			);
		};
		const waitForDurableWrites = async (): Promise<void> => {
			while (sessionState.durableWrites.size > 0) {
				await Promise.all([...sessionState.durableWrites]);
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
		const maintenancePort: SessionMaintenancePort = {
			addCompactionRequest: (request) => {
				sessionState.compaction.requests.add(request);
			},
			addRecoveryAttempt: (messageId) => {
				sessionState.recovery.attemptedMessages.add(messageId);
			},
			addRecoveryRun: (id) => {
				sessionState.recovery.activeRuns.add(id);
			},
			applyContext,
			compaction: ports.compaction,
			drainQueuedSubmissions: () => inputLane.drainQueuedSubmissions(),
			finishCompactionCommand: (command) => {
				if (
					sessionState.compaction.activeCommand?.promise !== command.promise
				) {
					return;
				}
				command.phase = "settled";
				sessionState.compaction.activeCommand = undefined;
				publish({});
			},
			getActiveCompaction: () => sessionState.compaction.activeCommand,
			getContext: () => this.#state.context,
			getRecoveryGeneration: () => sessionState.recovery.generation,
			getTranscript: () => this.#state.transcript,
			hasAttemptedRecovery: (messageId) =>
				sessionState.recovery.attemptedMessages.has(messageId),
			isClosed: () => sessionState.shutdown.closed,
			mergeTranscript,
			recordCompaction,
			removeCompactionRequest: (request) => {
				sessionState.compaction.requests.delete(request);
			},
			removeRecoveryAttempt: (messageId) => {
				sessionState.recovery.attemptedMessages.delete(messageId);
			},
			removeRecoveryRun: (id) => {
				sessionState.recovery.activeRuns.delete(id);
			},
			requestOverheadTokens: ports.turnRunner.requestOverheadTokens,
			resolveCompactionSettings: ports.resolveCompactionSettings,
			setActiveCompaction: (command) => {
				sessionState.compaction.activeCommand = command;
				publish({});
			},
			setCompactionError,
			setCompactionPhase: (command, phase) => {
				if (
					sessionState.compaction.activeCommand?.promise !== command.promise
				) {
					return;
				}
				command.phase = phase;
				publish({});
			},
			shutdownSignal: sessionState.shutdown.controller.signal,
			sessionId,
			trackBackgroundTask,
			waitForExecutionEnd,
		};
		maintenance = createSessionMaintenanceWorkflow(maintenancePort);

		let pipeline: SubmissionPipeline;
		let submissionCommand: SessionSubmissionCommand;
		pipeline = createSubmissionPipeline({
			applyContext,
			beginExecution,
			compact,
			continueContext: (input) => submissionCommand.continueContext(input),
			endExecution,
			fallbackSteeringMessages: (turnId) =>
				inputLane.fallbackSteeringMessages(turnId),
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
			takeSteeringMessages,
		});

		const beginSubmission = (
			input: SessionSendInput
		): {
			messageId: SessionMessageId | undefined;
			ownsTurnReservation: boolean;
		} => {
			if (sessionState.lane.runs === 0) {
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
				sessionState.lane.resolveIdle?.();
				sessionState.lane.resolveIdle = undefined;
			}
			if (sessionState.lane.runs === 0) {
				this.#runState = { phase: "idle" };
				publish({});
			}
			trackBackgroundTask(inputLane.drainQueuedSubmissions());
		};
		submissionCommand = createSessionSubmissionCommand({
			beginSubmission,
			cancelCompaction: cancelCompactionCommand,
			closeApprovals,
			deadlineMs,
			drainQueuedSubmissions: () => inputLane.drainQueuedSubmissions(),
			finishSubmission,
			getActiveSend: () => this.#activeSend,
			isBusyForContinuation: () =>
				this.#state.turnActive ||
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined,
			isClosed: () => sessionState.shutdown.closed,
			pipelineSend: (input, signal) => pipeline.send(input, signal),
			publishError: (error) => publish({ error }),
			rememberContinuationInput: (input) => {
				sessionState.continuationInputs.add(input);
			},
			reportSubmissionFailure,
			setActiveSend: (active) => {
				this.#activeSend = active;
			},
			trackBackgroundTask,
			waitForSubmissionLane: async () => {
				while (sessionState.lane.runs > 0) {
					await sessionState.lane.idle;
				}
			},
		});
		const abortActiveSend = submissionCommand.abortActiveSend;
		const runSubmission = submissionCommand.runSubmission;
		const waitForActiveSend = submissionCommand.waitForActiveSend;
		const inputLanePort: SessionInputLanePort = {
			addExternalization: (id, controller) => {
				sessionState.queue.externalizations.set(id, controller);
			},
			appendQueuedSubmission: (submission) =>
				publish({
					queuedSubmissions: [...this.#state.queuedSubmissions, submission],
				}),
			appendSteeringMessage: (message) =>
				publish({
					steeringMessages: [...this.#state.steeringMessages, message],
				}),
			canDrainQueue: () =>
				sessionState.lane.runs === 0 &&
				!this.#state.turnActive &&
				!this.#state.isCompacting &&
				sessionState.compaction.activeCommand === undefined &&
				sessionState.recovery.activeRuns.size === 0,
			emitSubmissionEvent,
			externalizeAttachments: (messages, signal) =>
				ports.attachments.externalize(messages, signal),
			getExternalization: (id) => sessionState.queue.externalizations.get(id),
			getSnapshot: () => this.#state,
			isClosed: () => sessionState.shutdown.closed,
			isExternalizing: (id) => sessionState.queue.externalizations.has(id),
			isQueueDraining: () => sessionState.queue.drainPhase === "draining",
			isSubmissionBusy: () =>
				sessionState.lane.runs > 0 ||
				sessionState.queue.drainPhase === "draining" ||
				this.#state.turnActive ||
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined ||
				sessionState.recovery.activeRuns.size > 0 ||
				sessionState.queue.externalizations.size > 0 ||
				this.#state.queuedSubmissions.length > 0,
			removeExternalization: (id) => {
				sessionState.queue.externalizations.delete(id);
			},
			removeQueuedSubmission: (id) => {
				const queued = this.#state.queuedSubmissions.find(
					(submission) => submission.id === id
				);
				if (queued === undefined) {
					return;
				}
				publish({
					queuedSubmissions: this.#state.queuedSubmissions.filter(
						(submission) => submission.id !== id
					),
				});
				return queued;
			},
			replaceInputLanes: (queuedSubmissions, steeringMessages) =>
				publish({ queuedSubmissions, steeringMessages }),
			replaceQueuedSubmission: (updated) =>
				publish({
					queuedSubmissions: this.#state.queuedSubmissions.map((submission) =>
						submission.id === updated.id ? updated : submission
					),
				}),
			reportSubmissionFailure,
			retainAttachments: (attachmentIds) =>
				ports.attachments.retain(attachmentIds),
			releaseAttachments: (attachmentIds) =>
				ports.attachments.release(attachmentIds),
			runSubmission,
			setQueueDraining: (draining) => {
				sessionState.queue.drainPhase = draining ? "draining" : "idle";
			},
			takeQueuedSubmission: (id) => {
				const [queued] = this.#state.queuedSubmissions;
				if (queued?.id !== id) {
					return;
				}
				publish({
					queuedSubmissions: this.#state.queuedSubmissions.slice(1),
				});
				return queued;
			},
			trackBackgroundTask,
		};
		inputLane = createSessionInputLaneWorkflow(inputLanePort);
		/**
		 * Interrupts local Agent Session authority immediately while the provider may
		 * still be physically unwinding. The execution signal fences every callback.
		 */
		const interruptActiveWork = (preserveToolCallId?: ToolCallId): void => {
			sessionState.recovery.generation += 1;
			this.#runState = { phase: "interrupted" };
			publish({});
			abortActiveSend("interrupted");
			interruptLatestAssistantMessage(preserveToolCallId);
			for (const execution of [...this.#state.executions]) {
				endExecution(execution.turnId);
			}
		};
		sessionState.approvals.abortTurn = interruptActiveWork;

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
			const input: SessionSendInput = {
				agent,
				messageId: anchor.id,
				model,
				sessionModel: initialSessionModel ?? anchor.metadata?.model ?? model,
				turnId,
				...omitUndefined({
					sessionVariant: initialSessionVariant ?? anchor.metadata?.variant,
					variant:
						lastMessage.metadata?.variant ??
						anchor.metadata?.variant ??
						initialSessionVariant,
				}),
			};
			return { kind: "ready", input, turnId };
		};
		const continueSession = (): SessionContinuationOutcome => {
			if (sessionState.shutdown.closed) {
				return { kind: "rejected", reason: SHUT_DOWN_SEND_ERROR };
			}
			if (
				sessionState.lane.runs > 0 ||
				sessionState.queue.drainPhase === "draining" ||
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
			inputLane.fallbackSteeringMessages();
			const waiting = this.#state.queuedSubmissions[0];
			if (waiting !== undefined) {
				trackBackgroundTask(inputLane.drainQueuedSubmissions());
				return {
					kind: "started-submission",
					messageId: waiting.messageId,
					submissionId: waiting.submissionId,
					...omitUndefined({ turnId: waiting.input.turnId }),
				};
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
		const interruptAll = (): SessionInterruptResult => {
			const approvalsSettled = this.#state.approvals.filter(
				(approval) => approval.decision === undefined
			).length;
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
			closeApprovals();
			if (hasCompaction) {
				cancelCompactionCommand();
				if (!hasTurn) {
					sessionState.recovery.generation += 1;
				}
			}
			if (hasTurn) {
				interruptActiveWork();
			}
			const recalled = inputLane.recallWaitingMessages();
			return { approvalsSettled, kind, recalled };
		};
		const hasPendingWork = (): boolean =>
			sessionState.lane.runs > 0 ||
			sessionState.queue.drainPhase === "draining" ||
			sessionState.compaction.activeCommand !== undefined ||
			sessionState.compaction.requests.size > 0 ||
			sessionState.approvals.settlements.size > 0 ||
			sessionState.durableWrites.size > 0 ||
			sessionState.backgroundTasks.size > 0 ||
			sessionState.recovery.activeRuns.size > 0 ||
			sessionState.queue.externalizations.size > 0 ||
			this.#state.turnActive ||
			this.#state.isCompacting ||
			this.#state.executions.length > 0;
		const shutdown = (): Promise<void> => {
			if (sessionState.shutdown.promise !== undefined) {
				return sessionState.shutdown.promise;
			}
			sessionState.shutdown.phase = "closing";
			sessionState.shutdown.controller.abort();
			for (const controller of sessionState.queue.externalizations.values()) {
				controller.abort();
			}
			// Whatever was waiting is dropped with the session: its attachment
			// holds end and nothing it held is ever run.
			inputLane.recallWaitingMessages();
			abortActiveSend("cancelled");
			closeApprovals();
			const compaction = sessionState.compaction.activeCommand?.promise;
			const completion = waitForShutdownWork(
				(async () => {
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
				})()
			);
			sessionState.shutdown.promise = completion.finally(() => {
				sessionState.shutdown.phase = "closed";
			});
			return sessionState.shutdown.promise;
		};

		this.internalPort = {
			abortApprovalTurn: (toolCallId) => {
				closeApprovals();
				interruptActiveWork(toolCallId);
			},
			beginExecution,
			commitRecord,
			endExecution,
			hasPendingWork,
			requestApproval,
			setExecutionViewState,
			shutdown,
		};
		this.continue = continueSession;
		this.cancel = () => {
			sessionState.recovery.generation += 1;
			abortActiveSend("cancelled");
		};
		this.cancelCompaction = () => {
			if (
				sessionState.compaction.activeCommand !== undefined ||
				this.#state.isCompacting ||
				sessionState.recovery.activeRuns.size > 0
			) {
				sessionState.recovery.generation += 1;
			}
			cancelCompactionCommand();
			return inputLane.recallWaitingMessages();
		};
		this.compact = compact;
		this.getSnapshot = () => this.#state;
		this.interrupt = (preserveToolCallId) => {
			closeApprovals();
			interruptActiveWork(preserveToolCallId);
			return inputLane.recallWaitingMessages();
		};
		this.interruptAll = interruptAll;
		this.recallWaitingMessages = inputLane.recallWaitingMessages;
		this.respondToApproval = settleApproval;
		this.prompt = inputLane.prompt;
		this.onSubmissionEvent = (listener) => {
			sessionState.events.submissionEvents.add(listener);
			return () => sessionState.events.submissionEvents.delete(listener);
		};
		this.send = inputLane.send;
		this.steer = inputLane.steer;
		this.subscribe = (listener) => {
			sessionState.events.observers.add(listener);
			return () => sessionState.events.observers.delete(listener);
		};
	}
}

import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	type SessionRecord,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import {
	getErrorMessage,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import { createSkillSnapshot, formatSkillUserContext } from "@/modules/skills";
import { toSteeringMessageId } from "@/shared/identifiers";
import { logSessionPersistenceFailure } from "@/shared/utils/session-persistence-diagnostics";
import type { CompactSessionResult } from "../compaction/compaction";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
import {
	createSessionUserMessage,
	isSessionToolPart,
	type SessionMessage,
	type SessionMessageMetadata,
	type SessionToolPart,
	withSubmissionStatus,
} from "../message";
import { buildUserSessionRecord } from "../storage/session-record";
import type { SessionSendInput, SessionSendOutcome } from "../submission-types";
import { createSessionApprovalWorkflow } from "./approval-workflow";
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
	SessionApprovalOutcome,
	SessionAttachmentBudget,
	SessionCompactionCommand,
	SessionContinuationOutcome,
	SessionExecution,
	SessionExecutionInput,
	SessionInterruptResult,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionQueuedSubmission,
	SessionSkillCatalog,
	SessionSteeringMessage,
	SessionSteeringStatus,
	SessionSubmissionEvent,
	SessionViewState,
} from "./types";
import { exposedViewState, hasChanged, primaryEntry } from "./utils";

/** The deadline one Agent Turn submission runs with. */
const AGENT_TURN_DEADLINE_MS = 43_200_000;

/** The reason a submission that arrives after the session ended is refused. */
const SHUT_DOWN_SEND_ERROR = "The session has ended.";
type SteeringRecordPreparation =
	| {
			kind: "ready";
			input: SessionSendInput;
			message: SessionMessage;
			record: SessionRecord;
			text: string;
			turnId?: AgentTurnId;
	  }
	| {
			kind: "rejected";
			messageId: SessionQueuedSubmission["messageId"];
			reason: string;
			submissionId: SessionQueuedSubmission["submissionId"];
	  };

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

type PreparedSteeringMessage = {
	readonly skillContext: SessionMessage[];
	readonly source: SessionSteeringMessage;
};

type ReadySteeringMessage = PreparedSteeringMessage & {
	readonly hydrated: SessionMessage;
};

type SteeringDeliveryFailure = {
	readonly reason: string;
	readonly source: SessionSteeringMessage;
};

type SteeringBatchPreparation = {
	readonly failure?: SteeringDeliveryFailure;
	readonly ready: ReadySteeringMessage[];
};

const STEERING_ATTACHMENT_PREPARATION_ERROR =
	"Steered Submission attachments could not be prepared.";

const hydrateSteeringBatch = (
	prepared: readonly PreparedSteeringMessage[],
	budget: SessionAttachmentBudget,
	ports: AgentSessionPorts,
	signal: AbortSignal
): Promise<SessionMessage[]> =>
	ports.attachments.hydrate({
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
	ports: AgentSessionPorts,
	signal: AbortSignal
): Promise<{ index: number; reason: string } | undefined> => {
	for (const [index, entry] of prepared.entries()) {
		try {
			await hydrateSteeringBatch([entry], budget, ports, signal);
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
	ports: AgentSessionPorts,
	signal: AbortSignal,
	failure: SteeringDeliveryFailure
): Promise<SteeringBatchPreparation> => {
	const first = prefix[0];
	if (first === undefined) {
		return { failure, ready: [] };
	}
	try {
		const hydrated = await hydrateSteeringBatch(prefix, budget, ports, signal);
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
	ports: AgentSessionPorts,
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
		ports,
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
		ports,
		signal,
		{ reason: unavailable.reason, source: failed.source }
	);
};

const prepareSteeringBatch = async (
	prepared: readonly PreparedSteeringMessage[],
	execution: SessionExecution,
	ports: AgentSessionPorts,
	signal: AbortSignal
): Promise<SteeringBatchPreparation> => {
	const first = prepared[0];
	if (first === undefined) {
		return { ready: [] };
	}
	let budget: SessionAttachmentBudget;
	try {
		const settings = await ports.resolveCompactionSettings(execution.model);
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
		const hydrated = await hydrateSteeringBatch(
			prepared,
			budget,
			ports,
			signal
		);
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
			: recoverSteeringBatch(prepared, budget, ports, signal, error);
	}
};

type SteeringSkillPreparation =
	| { readonly kind: "failed"; readonly reason: string }
	| {
			readonly kind: "ready";
			readonly skillContext: SessionMessage[];
	  };

const prepareSteeringSkill = async (
	source: SessionSteeringMessage,
	armedSkill: SessionSkillCatalog,
	ports: AgentSessionPorts
): Promise<SteeringSkillPreparation> => {
	const resolution = await ports.skills
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

type SteeringSkillBatchPreparation = {
	readonly failure?: SteeringDeliveryFailure;
	readonly prepared: PreparedSteeringMessage[];
};

const prepareSteeringSkills = async (
	sources: readonly SessionSteeringMessage[],
	armedSkill: SessionSkillCatalog,
	ports: AgentSessionPorts,
	signal: AbortSignal
): Promise<SteeringSkillBatchPreparation> => {
	const prepared: PreparedSteeringMessage[] = [];
	for (const source of sources) {
		if (source.status !== "pending" || signal.aborted) {
			break;
		}
		const skill = await prepareSteeringSkill(source, armedSkill, ports);
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
type PendingSteeringDelivery = Readonly<{
	execution: SessionExecution;
	message: SessionMessage;
	source: SessionSteeringMessage;
}>;
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
		readonly pendingSteering: Map<AgentTurnId, PendingSteeringDelivery[]>;
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
		steeringCommitId: SessionQueuedSubmission["id"] | undefined;
	};
	readonly recovery: {
		readonly activeRuns: Set<symbol>;
		readonly attemptedMessages: Set<SessionMessageId>;
		readonly steeringContinuations: Set<AgentTurnId>;
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
	#state: LiveSessionSnapshot;
	#runState: AgentSessionRunState = { phase: "idle" };

	constructor({
		deadlineMs = AGENT_TURN_DEADLINE_MS,
		initialCompactions = [],
		initialAgent,
		initialContext,
		initialSessionModel,
		initialSessionEffort,
		initialSessionReasoningMode,
		initialSteeringMessages = [],
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
			steeringMessages: [...initialSteeringMessages],
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
			executions: {
				endWaiters: new Map(),
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
				steeringCommitId: undefined,
			},
			recovery: {
				activeRuns: new Set(),
				attemptedMessages: new Set(),
				steeringContinuations: new Set(),
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
			const projectedChanges: Partial<LiveSessionSnapshot> = {
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
		const recoverOverflow = async (
			command: SessionOverflowRecoveryCommand
		): Promise<SessionOverflowRecoveryOutcome> => {
			if (sessionState.executions.pendingSteering.has(command.turnId)) {
				sessionState.recovery.steeringContinuations.add(command.turnId);
			}
			try {
				return await maintenance.recoverOverflow(command);
			} finally {
				sessionState.recovery.steeringContinuations.delete(command.turnId);
			}
		};

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
					sessionEffort: input.sessionEffort,
					sessionReasoningMode: input.sessionReasoningMode,
					submissionId: input.submissionId,
					effort: input.effort,
					reasoningMode: input.reasoningMode,
				}),
				sessionModel: input.sessionModel,
				sourceUserMessageId: input.sourceUserMessageId ?? null,
				startedAt: input.startedAt,
				turnId,
			};
			const initialSteering =
				sessionState.executions.pendingSteeringStarts.get(turnId);
			if (initialSteering !== undefined) {
				sessionState.executions.pendingSteeringStarts.delete(turnId);
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
					sessionState.executions.pendingSteering.get(sourceTurnId);
				if (previous === undefined) {
					continue;
				}
				sessionState.executions.pendingSteering.delete(sourceTurnId);
				sessionState.recovery.steeringContinuations.delete(sourceTurnId);
				for (const { message, source } of previous) {
					pendingSteering.push({ execution, message, source });
				}
				break;
			}
			if (pendingSteering.length > 0) {
				sessionState.executions.pendingSteering.set(turnId, pendingSteering);
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

		const persistSteeringStatus = async (
			source: SessionSteeringMessage,
			status: SessionSteeringStatus,
			reason?: string,
			afterId?: SessionSteeringMessage["id"]
		): Promise<SessionSteeringMessage> => {
			const failure =
				status === "failed"
					? (reason ?? "The Agent Turn ended before confirming the Submission.")
					: undefined;
			await agentSessionPorts.updateSubmissionStatus({
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
			const steeringMessages = this.#state.steeringMessages.filter(
				(entry) => entry.id !== source.id
			);
			if (status === "failed") {
				const previousIndex = isUndefined(afterId)
					? -1
					: steeringMessages.findIndex((entry) => entry.id === afterId);
				steeringMessages.splice(previousIndex + 1, 0, updated);
			}
			publish({
				context:
					status === "failed"
						? this.#state.context.filter((entry) => entry.id !== message.id)
						: this.#state.context.map((entry) =>
								entry.id === message.id ? message : entry
							),
				steeringMessages,
				transcript: this.#state.transcript.map((entry) =>
					entry.id === message.id ? message : entry
				),
			});
			return updated;
		};
		const acknowledgeSteeringMessages = async (
			turnId: AgentTurnId,
			status: "failed" | "processed",
			reason?: string
		): Promise<void> => {
			const pending = sessionState.executions.pendingSteering.get(turnId);
			if (pending === undefined) {
				return;
			}
			let previousFailureId: SessionSteeringMessage["id"] | undefined;
			for (const { execution, source } of pending) {
				const failure =
					status === "failed"
						? (reason ??
							"The Agent Turn ended before confirming the Submission.")
						: undefined;
				await persistSteeringStatus(source, status, failure, previousFailureId);
				if (status === "failed") {
					previousFailureId = source.id;
				}
				emitSubmissionEvent({
					kind: status,
					messageId: source.message.id,
					...omitUndefined({ reason: failure }),
					submissionId: source.input.submissionId,
					turnId: execution.turnId,
				});
			}
			sessionState.executions.pendingSteering.delete(turnId);
		};
		const failSteeringDelivery = async (
			execution: SessionExecution,
			source: SessionSteeringMessage,
			reason: string
		): Promise<SessionMessage[]> => {
			await persistSteeringStatus(source, "failed", reason);
			emitSubmissionEvent({
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
				if (sessionState.shutdown.closed || signal.aborted) {
					return messages;
				}
				const processing = await persistSteeringStatus(source, "processing");
				const pending =
					sessionState.executions.pendingSteering.get(execution.turnId) ?? [];
				const pendingIndex = pending.findIndex(
					(entry) => entry.source.id === processing.id
				);
				const delivery = {
					execution,
					message: processing.message,
					source: processing,
				};
				sessionState.executions.pendingSteering.set(
					execution.turnId,
					pendingIndex === -1
						? [...pending, delivery]
						: pending.map((entry, index) =>
								index === pendingIndex ? delivery : entry
							)
				);
				const context = this.#state.context.some(
					(message) => message.id === processing.message.id
				)
					? this.#state.context.map((message) =>
							message.id === processing.message.id
								? processing.message
								: message
						)
					: [...this.#state.context, processing.message];
				publish({ context });
				emitSubmissionEvent({
					kind: "delivered",
					messageId: processing.message.id,
					submissionId: processing.input.submissionId,
					turnId: execution.turnId,
				});
				messages.push(...skillContext, hydrated);
			}
			return messages;
		};
		const takeSteeringMessages = async (
			execution: SessionExecution,
			armedSkill: SessionSkillCatalog,
			signal: AbortSignal
		): Promise<SessionMessage[]> => {
			if (sessionState.shutdown.closed || !isUndefined(execution.parent)) {
				return [];
			}
			const pending =
				sessionState.executions.pendingSteering.get(execution.turnId) ?? [];
			const recoveredSources = pending.flatMap(({ source }) => {
				if (
					source.status !== "processing" ||
					this.#state.context.some(
						(message) => message.id === source.message.id
					) ||
					this.#state.steeringMessages.some(({ id }) => id === source.id)
				) {
					return [];
				}
				return [{ ...source, status: "pending" as const }];
			});
			const sources = [...recoveredSources, ...this.#state.steeringMessages];
			const skills = await prepareSteeringSkills(
				sources,
				armedSkill,
				ports,
				signal
			);
			if (sessionState.shutdown.closed || signal.aborted) {
				return [];
			}
			const preparation = await prepareSteeringBatch(
				skills.prepared,
				execution,
				ports,
				signal
			);
			if (sessionState.shutdown.closed || signal.aborted) {
				return [];
			}
			const messages = await deliverSteeringMessages(
				execution,
				preparation.ready,
				signal
			);
			if (sessionState.shutdown.closed || signal.aborted) {
				return messages;
			}
			const failure = preparation.failure ?? skills.failure;
			if (failure !== undefined) {
				await failSteeringDelivery(execution, failure.source, failure.reason);
			}
			return messages;
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
			acknowledgeSteeringMessages: (turnId, status, failure) =>
				acknowledgeSteeringMessages(turnId, status, failure),
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
			takeSteeringMessages,
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
		const persistSteeringRecord = async (
			record: SessionRecord,
			input: SessionSendInput
		): Promise<boolean> => {
			if (sessionState.shutdown.closed) {
				return false;
			}
			try {
				await agentSessionPorts.commitRecord({
					record,
					sessionId,
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
		const prepareSteeringRecord = async (
			queued: SessionQueuedSubmission,
			execution: SessionExecution | undefined,
			activeInput: SessionSendInput | undefined
		): Promise<SteeringRecordPreparation> => {
			if (sessionState.shutdown.closed) {
				return {
					kind: "rejected",
					messageId: queued.messageId,
					reason: SHUT_DOWN_SEND_ERROR,
					submissionId: queued.submissionId,
				};
			}
			const turnId =
				execution?.turnId ?? activeInput?.turnId ?? queued.input.turnId;
			const input = ports.resolveSubmission({
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
						execution?.sessionReasoningMode ??
						activeInput?.sessionReasoningMode,
				}),
				files: queued.input.composition.files,
				messageId: queued.messageId,
				reservedMessageId: undefined,
				submissionId: queued.submissionId,
				turnId,
				userText: queued.input.userText ?? queued.input.composition.text,
			});
			const text = input.userText ?? queued.input.composition.text;
			const fileMentions = await ports.resolveFileMentions(text);
			if (sessionState.shutdown.closed) {
				return {
					kind: "rejected",
					messageId: queued.messageId,
					reason: SHUT_DOWN_SEND_ERROR,
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
		const commitSteeringSubmission: SessionInputLanePort["commitSteeringSubmission"] =
			async (queued) => {
				const prepared = await prepareSteeringRecord(
					queued,
					primaryExecution(),
					sessionState.lane.activeInput
				);
				if (prepared.kind === "rejected") {
					return prepared;
				}
				const { input, message, record, text, turnId } = prepared;
				if (!(await persistSteeringRecord(record, input))) {
					return {
						kind: "rejected",
						messageId: queued.messageId,
						reason: "Could not durably commit the Submission.",
						submissionId: queued.submissionId,
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
				const queuedSubmissions = this.#state.queuedSubmissions.filter(
					(submission) => submission.id !== queued.id
				);
				const attachmentIds = queued.input.composition.files.flatMap(
					({ attachmentId }) =>
						attachmentId === undefined ? [] : [attachmentId]
				);
				publish({
					context: this.#state.context,
					queuedSubmissions,
					steeringMessages: [...this.#state.steeringMessages, steeringMessage],
					transcript: [...this.#state.transcript, message],
				});
				if (attachmentIds.length > 0) {
					ports.attachments.release(attachmentIds);
				}
				emitSubmissionEvent({
					kind: "steered",
					messageId: queued.messageId,
					submissionId: queued.submissionId,
					...omitUndefined({ turnId }),
				});
				return {
					kind: "steered",
					messageId: queued.messageId,
					submissionId: queued.submissionId,
					...omitUndefined({ turnId }),
				};
			};
		const executeCommittedSteering = async (
			source: SessionSteeringMessage
		): Promise<SessionSendOutcome> => {
			const turnId = createAgentTurnId();
			const processing = await persistSteeringStatus(source, "processing");
			const context = this.#state.context.some(
				(message) => message.id === processing.message.id
			)
				? this.#state.context.map((message) =>
						message.id === processing.message.id ? processing.message : message
					)
				: [...this.#state.context, processing.message];
			publish({ context });
			sessionState.executions.pendingSteeringStarts.set(turnId, processing);
			try {
				const outcome = await runSubmission(
					{
						...ports.resolveSubmission({
							...processing.input,
							turnId,
						}),
						turnId,
					},
					{ reportFailure: false }
				);
				if (!sessionState.executions.pendingSteeringStarts.has(turnId)) {
					return outcome;
				}
				sessionState.executions.pendingSteeringStarts.delete(turnId);
				const reason =
					outcome.rejected === true
						? outcome.reason
						: "The committed Submission did not start an Agent Turn.";
				await persistSteeringStatus(processing, "failed", reason);
				emitSubmissionEvent({
					kind: "failed",
					messageId: source.message.id,
					reason,
					submissionId: source.input.submissionId,
					turnId,
				});
				return { rejected: true, reason };
			} catch (error) {
				if (!sessionState.executions.pendingSteeringStarts.has(turnId)) {
					throw error;
				}
				sessionState.executions.pendingSteeringStarts.delete(turnId);
				const reason = getErrorMessage(
					error,
					"The committed Submission did not start an Agent Turn."
				);
				await persistSteeringStatus(processing, "failed", reason);
				emitSubmissionEvent({
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
			if (
				sessionState.shutdown.closed ||
				this.#state.steeringMessages[0]?.id !== source.id ||
				source.status !== expectedStatus
			) {
				return {
					rejected: true,
					reason: sessionState.shutdown.closed
						? SHUT_DOWN_SEND_ERROR
						: "The committed Submission is no longer waiting.",
				};
			}
			const isRetry = expectedStatus === "failed";
			if (isRetry && sessionState.executions.retryingSteering.has(source.id)) {
				return {
					rejected: true,
					reason: "The committed Submission is already being retried.",
				};
			}
			if (isRetry) {
				sessionState.executions.retryingSteering.add(source.id);
			}
			try {
				return await executeCommittedSteering(source);
			} finally {
				if (isRetry) {
					sessionState.executions.retryingSteering.delete(source.id);
				}
			}
		};
		const runSteeringMessage: SessionInputLanePort["runSteeringMessage"] = (
			message
		) => runCommittedSteering(message, "pending");
		const retrySteeringMessage: SessionInputLanePort["retrySteeringMessage"] = (
			message
		) => runCommittedSteering(message, "failed");
		const inputLanePort: SessionInputLanePort = {
			addExternalization: (id, controller, completion) => {
				sessionState.queue.externalizations.set(id, { completion, controller });
			},
			appendQueuedSubmission: (submission) =>
				publish({
					queuedSubmissions: [...this.#state.queuedSubmissions, submission],
				}),
			beginSteeringCommit: (id) => {
				if (
					sessionState.shutdown.closed ||
					sessionState.queue.steeringCommitId !== undefined ||
					this.#state.queuedSubmissions[0]?.id !== id
				) {
					return false;
				}
				sessionState.queue.steeringCommitId = id;
				return true;
			},
			commitSteeringSubmission,
			endSteeringCommit: (id) => {
				if (sessionState.queue.steeringCommitId !== id) {
					return;
				}
				sessionState.queue.steeringCommitId = undefined;
			},
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
			isExecutionBusy: () =>
				sessionState.lane.runs > 0 ||
				this.#state.turnActive ||
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined ||
				sessionState.recovery.activeRuns.size > 0,
			isExternalizing: (id) => sessionState.queue.externalizations.has(id),
			isQueueDraining: () => sessionState.queue.drainPhase === "draining",
			isSteeringCommitting: () =>
				sessionState.queue.steeringCommitId !== undefined,
			isSubmissionBusy: () =>
				sessionState.lane.runs > 0 ||
				sessionState.queue.drainPhase === "draining" ||
				this.#state.turnActive ||
				this.#state.isCompacting ||
				sessionState.compaction.activeCommand !== undefined ||
				sessionState.recovery.activeRuns.size > 0 ||
				sessionState.queue.externalizations.size > 0 ||
				this.#state.queuedSubmissions.length > 0 ||
				this.#state.steeringMessages.length > 0,
			removeExternalization: (id) => {
				sessionState.queue.externalizations.delete(id);
			},
			runSteeringMessage,
			retrySteeringMessage,
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
				publish({
					queuedSubmissions: [...queuedSubmissions],
					steeringMessages: [...steeringMessages],
				}),
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
			const sessionSelection =
				isUndefined(initialSessionEffort) &&
				isUndefined(initialSessionReasoningMode)
					? {
							effort: anchor.metadata?.effort,
							reasoningMode: anchor.metadata?.reasoningMode,
						}
					: {
							effort: initialSessionEffort,
							reasoningMode: initialSessionReasoningMode,
						};
			const messageSelection = (() => {
				if (
					!(
						isUndefined(lastMessage.metadata?.effort) &&
						isUndefined(lastMessage.metadata?.reasoningMode)
					)
				) {
					return lastMessage.metadata;
				}
				if (
					!(
						isUndefined(anchor.metadata?.effort) &&
						isUndefined(anchor.metadata?.reasoningMode)
					)
				) {
					return anchor.metadata;
				}
				return sessionSelection;
			})();
			const input: SessionSendInput = {
				agent,
				messageId: anchor.id,
				model,
				sessionModel: initialSessionModel ?? anchor.metadata?.model ?? model,
				turnId,
				...omitUndefined({
					sessionEffort: sessionSelection.effort,
					sessionReasoningMode: sessionSelection.reasoningMode,
					effort: messageSelection.effort,
					reasoningMode: messageSelection.reasoningMode,
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
			const steering = this.#state.steeringMessages[0];
			if (steering !== undefined) {
				if (steering.status !== "pending") {
					return {
						kind: "rejected",
						reason:
							steering.reason ??
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
		const interruptAll = async (): Promise<SessionInterruptResult> => {
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
			const recall = inputLane.recallWaitingMessages();
			trackBackgroundTask(recall);
			const recalled = await recall;
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
			for (const {
				controller,
			} of sessionState.queue.externalizations.values()) {
				controller.abort();
			}
			// Whatever was waiting is dropped with the session: its attachment
			// holds end and nothing it held is ever run.
			trackBackgroundTask(inputLane.recallWaitingMessages());
			abortActiveSend("cancelled");
			closeApprovals();
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
		this.cancelCompaction = async () => {
			if (
				sessionState.compaction.activeCommand !== undefined ||
				this.#state.isCompacting ||
				sessionState.recovery.activeRuns.size > 0
			) {
				sessionState.recovery.generation += 1;
			}
			cancelCompactionCommand();
			const recall = inputLane.recallWaitingMessages();
			trackBackgroundTask(recall);
			return await recall;
		};
		this.compact = compact;
		this.getSnapshot = () => this.#state;
		this.interrupt = async (preserveToolCallId) => {
			closeApprovals();
			interruptActiveWork(preserveToolCallId);
			const recall = inputLane.recallWaitingMessages();
			trackBackgroundTask(recall);
			return await recall;
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

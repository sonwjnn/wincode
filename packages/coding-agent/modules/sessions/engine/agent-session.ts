import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import {
	getErrorMessage,
	isError,
	isNull,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import {
	type SubmissionId,
	toQueuedSubmissionId,
	toSteeringMessageId,
	toSubmissionId,
} from "@/shared/identifiers";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	CompactSessionInput,
	CompactSessionResult,
} from "../compaction/compaction";
import { SessionCompactionError } from "../compaction/error";

import {
	isContextOverflowFailure,
	OverflowRecoveryError,
	prepareOverflowRecoveryMessages,
} from "../compaction/overflow-recovery";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
import {
	createSessionUserMessage,
	isSessionToolPart,
	type SessionFilePart,
	type SessionMessage,
	type SessionToolPart,
} from "../message";
import type {
	SessionSendInput,
	SessionSendOutcome,
	SessionSubmissionComposition,
} from "../session-operation";
import { createSessionOperation } from "../session-operation";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "../session-retry";
import { buildUserSessionRecord } from "../storage/session-record";
import {
	createSubmissionPipeline,
	type SubmissionPipeline,
	sessionSendCancelled,
} from "./submission";
import { interruptSessionContext } from "./turn";
import type {
	AgentSession,
	AgentSessionOptions,
	AgentSessionPorts,
	SessionApprovalOutcome,
	SessionApprovalResult,
	SessionCompactionCommand,
	SessionContinuationOutcome,
	SessionExecution,
	SessionExecutionInput,
	SessionInterruptResult,
	SessionOverflowContinuationOutcome,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionOverflowRecoveryTarget,
	SessionQueuedSendInput,
	SessionQueuedSubmission,
	SessionSnapshot,
	SessionSteeringAdmission,
	SessionSteeringMessage,
	SessionSubmissionAdmission,
	SessionSubmissionEvent,
	SessionViewState,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "./types";
import {
	acceptsSteeringMessages,
	exposedViewState,
	hasChanged,
	primaryEntry,
} from "./utils";

/** The deadline one Agent Turn submission runs with. */
const AGENT_TURN_DEADLINE_MS = 43_200_000;
/** The maximum time local shutdown waits for abort-resistant work to settle. */
const SESSION_SHUTDOWN_WAIT_TIMEOUT_MS = 5000;
const waitForShutdownWork = async (work: Promise<void>): Promise<void> => {
	let timeout: NodeJS.Timeout | undefined;
	const deadline = new Promise<void>((resolve) => {
		timeout = setTimeout(resolve, SESSION_SHUTDOWN_WAIT_TIMEOUT_MS);
	});
	try {
		await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timeout);
	}
};

/** The reason a submission that arrives after the session ended is refused. */
const SHUT_DOWN_SEND_ERROR = "The session has ended.";

/** The reason a queued submission's attachments could not be kept. */
const QUEUED_ATTACHMENT_ERROR = "Attachment data could not be stored.";

/** The reason a Steering Message carrying attachments is refused. */
const STEERING_ATTACHMENT_ERROR =
	"A Steering Message carries text only: attachments are not accepted.";

/** The reason a Steering Message invoking a Skill is refused. */
const STEERING_SKILL_ERROR =
	"A Steering Message cannot invoke a Skill: it carries text only.";

/** The reason a Steering Message that is not a fresh prompt is refused. */
const STEERING_INVOCATION_ERROR =
	"A Steering Message carries text only: it cannot resend or edit another message.";

/** The reason an explicit Steering Message has no live Agent Turn to join. */
const STEERING_INACTIVE_ERROR =
	"An active Agent Turn is required to accept a Steering Message.";
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

/** The attachment blobs one queued composition holds. */
const queuedAttachmentIds = ({
	composition,
}: SessionQueuedSendInput): string[] =>
	composition.files.flatMap(({ attachmentId }) =>
		isUndefined(attachmentId) ? [] : [attachmentId]
	);

/** Preserves attachment reference counts while compositions are externalized. */
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

/**
 * The single owner of one session's live state and the only writer to it.
 * Observers read a Session Snapshot and never write; the Agent Session replaces
 * it instead of mutating it.
 */
export const createAgentSession = ({
	initialCompactions = [],
	initialAgent,
	initialContext,
	initialSessionModel,
	initialSessionVariant,
	initialTranscript,
	ports,
	sessionId,
}: AgentSessionOptions): AgentSession => {
	let state: SessionSnapshot = {
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
	/**
	 * The compaction command the Agent Session is running, kept for its abort
	 * handle and for callers that join it. Whether a request may run at all is
	 * the Session Compaction module's decision, never this record's.
	 */
	let compactionCommand:
		| {
				abort: () => void;
				promise: Promise<CompactSessionResult>;
				/** Resolves once the Session Compaction module has admitted the request. */
				registered: Promise<void>;
				settled: boolean;
		  }
		| undefined;
	const listeners = new Set<() => void>();
	const submissionListeners = new Set<
		(event: SessionSubmissionEvent) => void
	>();
	const emitSubmissionEvent = (event: SessionSubmissionEvent): void => {
		for (const listener of [...submissionListeners]) {
			try {
				listener(event);
			} catch {
				// Observers cannot change Agent Session authority.
			}
		}
	};
	/**
	 * The settlement of each pending approval, keyed by its registry id. A
	 * request is removed before its settlement is published, so a second route
	 * finds nothing to settle and can never settle the same request twice.
	 */
	const pendingApprovals = new Map<
		string,
		(outcome: SessionApprovalOutcome) => void
	>();
	/**
	 * The user messages that have used their one overflow recovery attempt. The
	 * attempt stays keyed to the failed turn's original message, so continuing
	 * its context cannot chain into another recovery and no command resets it.
	 */
	const recoveryAttempts = new Set<SessionMessageId>();
	/** Monotonic fence for recovery work after any local interruption. */
	let interruptEpoch = 0;
	let activeOverflowRecoveries = 0;

	/**
	 * The waiters of each live execution, resolved when that execution ends, so
	 * work that must not run during an Agent Turn can wait for it to end instead
	 * of guessing whether it has.
	 */
	const executionEndWaiters = new Map<AgentTurnId, (() => void)[]>();
	/** Assigned once the operation exists so approval aborts use its command. */
	let interruptApprovalTurn: (toolCallId?: ToolCallId) => void = () =>
		undefined;

	let approvalCounter = 0;
	let isShutDown = false;
	const shutdownController = new AbortController();
	let shutdownPromise: Promise<void> | undefined;
	/**
	 * Session records delivered by the Steering Lane are started at the Model
	 * Step boundary and intentionally do not block that step. Shutdown must still
	 * await them before the Session Host can release its lease.
	 */
	const pendingDurableWrites = new Set<Promise<void>>();
	const commitRecord: AgentSessionPorts["commitRecord"] = (input) => {
		if (isShutDown) {
			return Promise.resolve();
		}
		const write = ports.commitRecord(input);
		pendingDurableWrites.add(write);
		void write.then(
			() => pendingDurableWrites.delete(write),
			() => pendingDurableWrites.delete(write)
		);
		return write;
	};
	/**
	 * Every public compaction request remains tracked through joined admission,
	 * including a request whose owner finishes before its own settings resolve.
	 */
	const pendingCompactions = new Set<Promise<CompactSessionResult>>();
	/**
	 * Post-turn maintenance starts without delaying the command response, but
	 * ownership still covers its compaction decision until it settles.
	 */
	const pendingBackgroundTasks = new Set<Promise<unknown>>();
	const pendingAttachmentControllers = new Map<
		SessionQueuedSubmission["id"],
		AbortController
	>();
	/**
	 * Late runtime callbacks can still settle after cancellation. They must not
	 * reach the durable store once the Agent Session has lost authority.
	 */
	const agentSessionPorts: AgentSessionPorts = { ...ports, commitRecord };
	/**
	 * How many submission runs hold the send lane. An overflow continuation may
	 * start after the failed turn ends but before its proposing run settles, so
	 * the lane is counted rather than flagged, and is free only at zero.
	 */
	let laneRuns = 0;
	let laneIdle: Promise<void> = Promise.resolve();
	let resolveLaneIdle: (() => void) | undefined;
	/** The turn reserved by a run before its execution enters the snapshot. */
	let activeAdmissionTurnId: AgentTurnId | undefined;
	const contextContinuationInputs = new WeakSet<SessionSendInput>();
	let draining = false;
	/** Whether the drain loop is walking the Submission Queue. */
	const publish = (changes: Partial<SessionSnapshot>): void => {
		if (!hasChanged(state, changes)) {
			return;
		}
		const transcript = changes.transcript;
		const transcriptChanged =
			transcript !== undefined &&
			(state.transcript.length !== transcript.length ||
				state.transcript.some(
					(message, index) => message !== transcript[index]
				));
		const nextChanges =
			transcriptChanged === true
				? {
						...changes,
						transcriptRevision: (state.transcriptRevision ?? 0) + 1,
					}
				: changes;
		state = { ...state, ...nextChanges };
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// An observer cannot change session state.
			}
		}
	};
	/** Settles one request through the Agent Session's single authority path. */
	const settleApproval = (
		id: string,
		outcome: SessionApprovalOutcome
	): SessionApprovalResult => {
		const resolveApproval = pendingApprovals.get(id);
		const approval = state.approvals.find(
			(candidate) => candidate.id === id && isUndefined(candidate.decision)
		);
		if (isUndefined(resolveApproval) || approval === undefined) {
			return { applied: false };
		}
		if (
			outcome.decision === "allow" &&
			outcome.remember &&
			approval.request.safety === true
		) {
			return {
				applied: false,
				reason: "persistence-forbidden",
			};
		}
		pendingApprovals.delete(id);
		publish({
			approvals: state.approvals.map((candidate) =>
				candidate.id === id ? { ...candidate, decision: outcome } : candidate
			),
		});
		if (outcome.decision === "abort") {
			closeApprovals();
			interruptApprovalTurn(approval.request.toolCallId);
		}
		resolveApproval(outcome);
		return { applied: true };
	};
	const requestApproval = (
		request: ToolApprovalRequest
	): Promise<SessionApprovalOutcome> => {
		// A session that has shut down has nothing to ask: the request settles
		// immediately so its Tool Gate evaluation can never wait forever.
		if (isShutDown) {
			return Promise.resolve({ decision: "reject" });
		}
		const id = request.toolCallId ?? `session-${approvalCounter++}`;
		// One identifier addresses one pending request. A request that reuses a
		// pending Tool Call Identifier is refused instead of replacing the request
		// the panel still shows, so neither evaluation can be left waiting.
		if (pendingApprovals.has(id)) {
			return Promise.resolve({ decision: "reject" });
		}
		const { promise, resolve } =
			Promise.withResolvers<SessionApprovalOutcome>();
		pendingApprovals.set(id, resolve);
		publish({
			approvals: [
				...state.approvals,
				{
					id,
					request,
					target: isUndefined(request.toolCallId) ? "session" : "tool-call",
				},
			],
		});
		return promise;
	};
	const closeApprovals = (feedback?: string): void => {
		const pending = state.approvals.filter((approval) =>
			isUndefined(approval.decision)
		);
		// The newest pending request — the panel on top of the stack — carries
		// the typed feedback; every sibling is rejected without it.
		const selectedId = isUndefined(feedback) ? undefined : pending.at(-1)?.id;
		for (const approval of pending) {
			settleApproval(
				approval.id,
				approval.id === selectedId
					? { decision: "reject", feedback }
					: { decision: "reject" }
			);
		}
	};
	const applyContext = (messages: readonly SessionMessage[]): void => {
		publish({ context: [...messages] });
	};
	const mergeTranscript = (
		messages: readonly SessionMessage[]
	): readonly SessionMessage[] => {
		const merged = [...state.transcript];
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
		if (state.compactions.some(({ id }) => id === entry.id)) {
			return;
		}
		publish({ compactions: [...state.compactions, entry] });
	};
	const setCompacting = (value: boolean): void => {
		publish({ isCompacting: value });
	};
	const setCompactionError = (error: Error | null): void => {
		if (isShutDown) {
			return;
		}
		publish({ compactionError: error });
	};
	/**
	 * The settings one compaction command runs with: the resolved compaction
	 * settings of its Model Target plus the request overhead of the Agent Turn
	 * execution in flight, so the compaction reserves what the next turn sends.
	 */
	const compactionSettingsFor = async (
		model: CompactSessionInput["model"]
	): Promise<CompactSessionInput["settings"]> => {
		const settings = await ports.resolveCompactionSettings(model);
		return {
			compactionOverheadTokens: ports.runtime.requestOverheadTokens(),
			enabled: settings.enabled,
			keepRecentTokens: settings.keepRecentTokens,
			maxMediaAttachments: settings.maxMediaAttachments,
			maxMediaBytes: settings.maxMediaBytes,
			maxMediaTokens: settings.maxMediaTokens,
			modelContextLimit: settings.modelContextLimit,
			reserveTokens: settings.reserveTokens,
			thresholdTokens: settings.thresholdTokens,
		};
	};
	/** A command that carries its own transcript update merges it before running. */
	const compactionSource = (
		command: SessionCompactionCommand
	): readonly SessionMessage[] => {
		if (!isUndefined(command.sourceMessages)) {
			return [...command.sourceMessages];
		}
		if (!isUndefined(command.nextMessages)) {
			return mergeTranscript(command.nextMessages);
		}
		return state.transcript;
	};
	const compactionRequest = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[],
		signal: AbortSignal
	): Promise<CompactSessionInput> => ({
		model: command.model,
		session: { messages, sessionId },
		settings: await compactionSettingsFor(command.model),
		trigger: command.trigger,
		...omitUndefined({ focus: command.focus, variant: command.variant }),
		signal,
	});
	/**
	 * Runs a command the module admitted. The Session Context swap and the
	 * compaction entry it produces are published by the command, before its
	 * promise settles, so a caller that joins it reads a settled context.
	 */
	const startCompaction = (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const controller = new AbortController();
		const registration = Promise.withResolvers<void>();
		const { promise, reject, resolve } =
			Promise.withResolvers<CompactSessionResult>();
		compactionCommand = {
			abort: () => controller.abort(),
			promise,
			registered: registration.promise,
			settled: false,
		};
		setCompacting(true);
		void (async () => {
			try {
				const request = await compactionRequest(
					command,
					messages,
					AbortSignal.any([controller.signal, shutdownController.signal])
				);
				if (controller.signal.aborted || isShutDown) {
					throw new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR);
				}
				// Admission happens when the module is entered, so a request that
				// arrives while this one resolves its settings still joins it.
				const admitted = ports.compaction.compact(request);
				registration.resolve();
				const result = await admitted;
				if (controller.signal.aborted || isShutDown) {
					throw new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR);
				}
				applyContext(result.activeMessages);
				recordCompaction(result.entry);
				setCompactionError(null);
				resolve(result);
			} catch (error) {
				registration.resolve();
				reject(error);
			} finally {
				if (compactionCommand?.promise === promise) {
					compactionCommand.settled = true;
					compactionCommand = undefined;
					setCompacting(false);
				}
				// A submission that arrived while this compaction held the lane
				// runs as soon as it no longer does.
				trackBackgroundTask(drainQueuedSubmissions());
			}
		})();
		return promise;
	};
	/**
	 * Joins the command in flight. A request that carries its intent is answered
	 * by that command; one that carries another intent is refused, so a caller is
	 * never answered with another caller's entry. A joined request's messages
	 * never travel — the command it joins owns the swap — so the Session
	 * Transcript is the source it names.
	 */
	const joinCompaction = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const owner = compactionCommand;
		// The command this one joins may still be resolving its settings, and the
		// module only knows a request it has been entered with: wait for that
		// admission before asking it to join, so its decision is about a request
		// it can already see.
		if (!isUndefined(owner)) {
			await owner.registered;
			if (owner.settled) {
				return compact(command);
			}
		}
		if (isShutDown) {
			throw new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR);
		}
		const request = await compactionRequest(
			command,
			messages,
			shutdownController.signal
		);
		if (isShutDown) {
			throw new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR);
		}
		if (!isUndefined(owner) && owner.settled) {
			return compact(command);
		}
		const result = await ports.compaction.compact(request);
		if (!isUndefined(owner)) {
			await owner.promise;
		}
		return result;
	};
	const trackPendingCompaction = (
		result: Promise<CompactSessionResult>
	): Promise<CompactSessionResult> => {
		pendingCompactions.add(result);
		void (async () => {
			try {
				await result;
			} catch {
				// The compaction caller observes the original rejection.
			} finally {
				pendingCompactions.delete(result);
			}
		})();
		return result;
	};
	const compact = (
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		if (isShutDown) {
			return Promise.reject(
				new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR)
			);
		}
		const messages = compactionSource(command);
		// The Agent Session's own command is checked first: a request that arrives
		// while it still resolves settings joins it rather than starting a second
		// command the Session Compaction module would refuse.
		const running =
			compactionCommand ?? ports.compaction.getInFlight(sessionId);
		const result = isNull(running)
			? startCompaction(command, messages)
			: joinCompaction(command, messages);
		return trackPendingCompaction(result);
	};
	const settleCompaction = async (): Promise<Error | null> => {
		// A command that starts while this waits is joined too, so a caller that
		// continues afterwards reads a context no compaction is about to replace.
		while (true) {
			const command = compactionCommand;
			if (isUndefined(command)) {
				return null;
			}
			try {
				await command.promise;
			} catch (error) {
				return isError(error) ? error : new Error("Session compaction failed.");
			}
		}
	};
	/**
	 * Resolves once the Agent Turn that proposed a recovery has ended; an
	 * execution that is not live has already ended.
	 */
	const waitForExecutionEnd = (turnId: AgentTurnId): Promise<void> => {
		if (!state.executions.some((execution) => execution.turnId === turnId)) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		const waiters = executionEndWaiters.get(turnId);
		if (isUndefined(waiters)) {
			executionEndWaiters.set(turnId, [resolve]);
		} else {
			waiters.push(resolve);
		}
		return promise;
	};
	/** One recovery failure with the context-continuation error code it publishes. */
	const recoveryError = (
		message: string,
		cause: unknown
	): OverflowRecoveryError =>
		new OverflowRecoveryError("continuation-failed", message, { cause });
	/**
	 * Publishes one recovery failure as the compaction error and reports it, so
	 * a caller that proposed the recovery has nothing left to continue.
	 */
	const failRecovery = (
		error: OverflowRecoveryError
	): SessionOverflowRecoveryOutcome => {
		if (!isShutDown) {
			setCompactionError(error);
		}
		return { kind: "failed", error };
	};
	/**
	 * Runs one recovery: it records the attempt against the user message the
	 * failed turn answers, compacts eligible history through the Agent
	 * Session's own compaction command, then continues the resulting Session
	 * Context without appending the original user message. A refused or failed
	 * continuation is published as the compaction error, not queued by its caller.
	 */
	const runOverflowRecovery = async (
		command: SessionOverflowRecoveryCommand
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery owns independent eligibility, compaction, and continuation failure boundaries.
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (!isContextOverflowFailure(command.error)) {
			return { kind: "ineligible" };
		}
		// Recorded before anything is awaited, so the attempt covers the whole
		// recovery: a refusal that arrives while this one is under way is refused
		// as exhausted rather than starting a second compaction, and no send or
		// command can reset it.
		if (recoveryAttempts.has(command.originalMessageId)) {
			return { kind: "exhausted" };
		}
		const originalMessageIndex = state.context.findIndex(
			(message) =>
				message.id === command.originalMessageId && message.role === "user"
		);
		if (
			originalMessageIndex !== -1 &&
			hasCompletedToolArtifact(
				getSessionAttemptMessages(state.context, originalMessageIndex)
			)
		) {
			return { kind: "ineligible" };
		}
		recoveryAttempts.add(command.originalMessageId);
		const recoveryEpoch = interruptEpoch;
		let target: SessionOverflowRecoveryTarget | null;
		try {
			target = await command.resolveTarget();
		} catch (error) {
			if (isShutDown || recoveryEpoch !== interruptEpoch) {
				return { kind: "ineligible" };
			}
			return failRecovery(
				recoveryError(
					"Context overflow recovery could not resolve its compaction settings.",
					error
				)
			);
		}
		if (isNull(target)) {
			// Nothing was tried, so the message keeps its one attempt.
			recoveryAttempts.delete(command.originalMessageId);
			return { kind: "ineligible" };
		}
		if (isShutDown || recoveryEpoch !== interruptEpoch) {
			return { kind: "ineligible" };
		}
		let result: CompactSessionResult;
		try {
			result = await compact({
				model: target.model,
				sourceMessages: prepareOverflowRecoveryMessages(
					state.transcript,
					command.originalMessageId
				),
				trigger: "overflow",
				...omitUndefined({ variant: target.variant }),
			});
		} catch (error) {
			if (isShutDown || recoveryEpoch !== interruptEpoch) {
				return { kind: "ineligible" };
			}
			return failRecovery(
				error instanceof OverflowRecoveryError
					? error
					: recoveryError(
							`Context overflow recovery could not compact the session.${getErrorMessage(error, "")}`,
							error
						)
			);
		}
		await waitForExecutionEnd(command.turnId);
		// Context continuation waits for the failed execution so it cannot overlap
		// that turn or outlive a local interruption.
		if (isShutDown || recoveryEpoch !== interruptEpoch) {
			return { kind: "ineligible" };
		}
		let continuationOutcome: SessionOverflowContinuationOutcome;
		try {
			continuationOutcome = await command.continueContext({
				originalMessageId: command.originalMessageId,
			});
		} catch (error) {
			if (isShutDown || recoveryEpoch !== interruptEpoch) {
				return { kind: "ineligible" };
			}
			return failRecovery(
				recoveryError(
					"Context overflow recovery could not continue the compacted Session Context.",
					error
				)
			);
		}
		if (isShutDown || recoveryEpoch !== interruptEpoch) {
			return { kind: "ineligible" };
		}
		if (continuationOutcome.kind === "refused") {
			return failRecovery(
				new OverflowRecoveryError(
					"continuation-refused",
					`Context overflow recovery could not continue the compacted Session Context: ${continuationOutcome.reason}`,
					{ cause: command.error }
				)
			);
		}
		return { kind: "recovered", entry: result.entry };
	};
	const recoverOverflow = (
		command: SessionOverflowRecoveryCommand
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (isShutDown) {
			return Promise.resolve({ kind: "ineligible" });
		}
		activeOverflowRecoveries += 1;
		const recovery = runOverflowRecovery(command);
		void recovery.then(
			() => {
				activeOverflowRecoveries -= 1;
				trackBackgroundTask(drainQueuedSubmissions());
			},
			() => {
				activeOverflowRecoveries -= 1;
				trackBackgroundTask(drainQueuedSubmissions());
			}
		);
		return recovery;
	};

	/** Ends an execution and wakes everything waiting for it to end. */
	const endExecution = (turnId: AgentTurnId): void => {
		const waiters = executionEndWaiters.get(turnId);
		if (!isUndefined(waiters)) {
			executionEndWaiters.delete(turnId);
			for (const resolveEnd of waiters) {
				resolveEnd();
			}
		}
		const executions = state.executions.filter(
			(execution) => execution.turnId !== turnId
		);
		if (executions.length === state.executions.length) {
			return;
		}
		publish({ executions, viewState: exposedViewState(executions) });
	};
	const setTurnActive = (value: boolean): void =>
		publish({ turnActive: value });

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
		publish({ executions: [...state.executions, execution] });
		return execution;
	};
	const setExecutionViewState = (
		turnId: AgentTurnId,
		viewState: SessionViewState
	): void => {
		if (!state.executions.some((execution) => execution.turnId === turnId)) {
			return;
		}
		const executions = state.executions.map((execution) =>
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
		primaryEntry(state.executions);
	/**
	 * Presents an interrupted turn: the target message keeps the interrupted
	 * Tool Call the abort named and the context is sanitized around it.
	 */
	const interruptLatestAssistantMessage = (
		preserveToolCallId?: ToolCallId
	): void => {
		const next = interruptSessionContext(
			state.context,
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
			isShutDown ||
			!isUndefined(execution.parent) ||
			state.steeringMessages.length === 0
		) {
			return [];
		}
		const taken = state.steeringMessages;
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
		applyContext([...state.context, ...delivered]);
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
		pendingDurableWrites.add(write);
		void write.then(
			() => pendingDurableWrites.delete(write),
			() => pendingDurableWrites.delete(write)
		);
	};
	const waitForDurableWrites = async (): Promise<void> => {
		while (pendingDurableWrites.size > 0) {
			await Promise.all([...pendingDurableWrites]);
		}
	};
	const waitForCompactions = async (): Promise<void> => {
		while (pendingCompactions.size > 0) {
			await Promise.all(
				[...pendingCompactions].map(async (compaction) => {
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
		pendingBackgroundTasks.add(task);
		void (async () => {
			try {
				await task;
			} catch {
				// Maintenance failures are surfaced by their own error path.
			} finally {
				pendingBackgroundTasks.delete(task);
			}
		})();
	};
	const waitForBackgroundTasks = async (): Promise<void> => {
		while (pendingBackgroundTasks.size > 0) {
			await Promise.all(
				[...pendingBackgroundTasks].map(async (task) => {
					try {
						await task;
					} catch {
						// A shutdown-triggered maintenance cancellation is expected.
					}
				})
			);
		}
	};
	/**
	 * Moves Steering Messages that missed their Model Step boundary to the
	 * Submission Queue when their turn ends. Their relative acceptance order is
	 * kept, and they run ahead of newer queued prompts.
	 */
	const fallbackSteeringMessages = (turnId?: AgentTurnId): void => {
		if (isShutDown || state.steeringMessages.length === 0) {
			return;
		}
		const isOwnedByTurn = (message: SessionSteeringMessage): boolean =>
			turnId === undefined || message.input.turnId === turnId;
		const waiting = state.steeringMessages
			.filter(isOwnedByTurn)
			.map(({ input }) => {
				const messageId =
					input.messageId ?? toSessionMessageId(`msg-${crypto.randomUUID()}`);
				const submissionId =
					input.submissionId ??
					toSubmissionId(`submission-${crypto.randomUUID()}`);
				const turnId = createAgentTurnId();
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
						turnId,
						userText: input.text,
						...omitUndefined({
							resolvedAgent: input.resolvedAgent,
							sessionVariant: input.sessionVariant,
							variant: input.variant,
						}),
					},
				};
			});
		if (waiting.length === 0) {
			return;
		}
		publish({
			queuedSubmissions: [...waiting, ...state.queuedSubmissions],
			steeringMessages: state.steeringMessages.filter(
				(message) => !isOwnedByTurn(message)
			),
		});
	};

	let pipeline: SubmissionPipeline;
	const operation = createSessionOperation({
		deadlineMs: AGENT_TURN_DEADLINE_MS,
		execute: async (input, signal) => {
			if (signal.aborted) {
				return sessionSendCancelled(signal);
			}
			const stop = (): void => {
				compactionCommand?.abort();
				closeApprovals();
			};
			signal.addEventListener("abort", stop, { once: true });
			try {
				return await pipeline.send(input, signal);
			} catch (error) {
				// A submission that throws still publishes its failure, and the
				// caller that awaited the send is the one that answers it.
				if (!isShutDown) {
					publish({
						error: isError(error) ? error : new Error("Session failed."),
					});
				}
				throw error;
			} finally {
				signal.removeEventListener("abort", stop);
			}
		},
		onInterrupt: interruptLatestAssistantMessage,
	});
	pipeline = createSubmissionPipeline({
		applyContext,
		beginExecution,
		compact,
		continueContext: (input) => continueContextRun(input),
		endExecution,
		fallbackSteeringMessages,
		getContext: () => state.context,
		getTranscript: () => state.transcript,
		isShutDown: () => isShutDown,
		isContextContinuation: (input) => contextContinuationInputs.has(input),
		mergeTranscript,
		ports: agentSessionPorts,
		recoverOverflow,
		sessionId,
		setCatalogDiagnostic: (diagnostic) =>
			publish({ catalogDiagnostic: diagnostic }),
		setCompactionError,
		setError: (error) => publish({ error }),
		setExecutionViewState,
		setTurnActive,
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
		if (laneRuns === 0) {
			const idle = Promise.withResolvers<void>();
			laneIdle = idle.promise;
			resolveLaneIdle = idle.resolve;
		}
		laneRuns += 1;
		const ownsTurnReservation =
			activeAdmissionTurnId === undefined && input.turnId !== undefined;
		if (ownsTurnReservation) {
			activeAdmissionTurnId = input.turnId;
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
		if (ownsTurnReservation && activeAdmissionTurnId === input.turnId) {
			activeAdmissionTurnId = undefined;
		}
		laneRuns -= 1;
		if (laneRuns === 0) {
			resolveLaneIdle?.();
			resolveLaneIdle = undefined;
		}
		trackBackgroundTask(drainQueuedSubmissions());
	};
	const runSubmission = async (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		const { messageId, ownsTurnReservation } = beginSubmission(input);
		try {
			const outcome = await operation.send(input);
			if (outcome.rejected) {
				reportSubmissionFailure(input, messageId, outcome.reason);
			}
			return outcome;
		} catch (error) {
			reportSubmissionFailure(
				input,
				messageId,
				getErrorMessage(error, "The Submission failed.")
			);
			throw error;
		} finally {
			finishSubmission(input, ownsTurnReservation);
		}
	};
	const continueContextRun = async (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		if (isShutDown) {
			return { rejected: true, reason: SHUT_DOWN_SEND_ERROR };
		}
		await operation.waitForIdle();
		while (laneRuns > 0) {
			await laneIdle;
		}
		if (
			isShutDown ||
			state.turnActive ||
			state.isCompacting ||
			compactionCommand !== undefined
		) {
			return { rejected: true, reason: "The Agent Session is busy." };
		}
		const continuationInput = {
			...input,
			turnId: input.turnId ?? createAgentTurnId(),
		};
		contextContinuationInputs.add(continuationInput);
		return await runSubmission(continuationInput);
	};
	/**
	 * Interrupts local Agent Session authority immediately while the provider may
	 * still be physically unwinding. The execution signal fences every callback.
	 */
	const interruptActiveWork = (preserveToolCallId?: ToolCallId): void => {
		interruptEpoch += 1;
		operation.interrupt(preserveToolCallId);
		for (const execution of [...state.executions]) {
			endExecution(execution.turnId);
		}
		setTurnActive(false);
	};
	interruptApprovalTurn = interruptActiveWork;

	/** Releases the blobs of compositions nothing holds any more. */
	const releaseQueuedAttachments = (
		submissions: readonly SessionQueuedSubmission[]
	): void => {
		const attachmentIds = submissions.flatMap(({ input }) =>
			queuedAttachmentIds(input)
		);
		if (attachmentIds.length > 0) {
			ports.attachments.release(attachmentIds);
		}
	};
	/**
	 * Stores a composition's attachments, so a queued wait cannot outlive the
	 * blobs it still shows.
	 */
	const storeCompositionFiles = async (
		files: readonly SessionFilePart[],
		signal: AbortSignal
	): Promise<SessionFilePart[]> => {
		if (files.every((file) => !isUndefined(file.attachmentId))) {
			return [...files];
		}
		const [stored] = await ports.attachments.externalize(
			[createSessionUserMessage("", undefined, [], [...files])],
			signal
		);
		return (stored?.parts ?? []).filter(
			(part): part is SessionFilePart => part.type === "file"
		);
	};
	/**
	 * Runs queued submissions one Agent Turn at a time, oldest first, until the
	 * queue is empty. It never overlaps the lane: while a submission run holds
	 * it, while a turn is live, or while the queue is already being walked, this
	 * does nothing, and the run that ends continues the walk through its own
	 * release. A compaction in flight holds the queue too, so a waiting
	 * submission stays visible in the Submission Queue until the compaction it
	 * would join has landed.
	 */
	const drainQueuedSubmissions = async (): Promise<void> => {
		if (
			draining ||
			isShutDown ||
			laneRuns > 0 ||
			state.turnActive ||
			state.isCompacting ||
			compactionCommand !== undefined ||
			activeOverflowRecoveries > 0
		) {
			return;
		}
		draining = true;
		try {
			while (!isShutDown) {
				const next = state.queuedSubmissions[0];
				if (isUndefined(next) || pendingAttachmentControllers.has(next.id)) {
					break;
				}
				// The item stops waiting before it runs: it is no longer
				// something a Recall can withdraw, and its Agent Turn is what
				// commits it to the Session Transcript.
				publish({ queuedSubmissions: state.queuedSubmissions.slice(1) });
				try {
					await runSubmission(next.input);
				} catch {
					// The submission published its own failure, and a failed
					// turn never strands the submissions behind it.
				}
				// The Session Records this run committed name these blobs now.
				releaseQueuedAttachments([next]);
			}
		} finally {
			draining = false;
		}
	};
	/**
	 * Reserves a queue position immediately, then externalizes attachments
	 * without allowing later Submissions to pass the pending entry.
	 */
	const removeQueuedSubmission = (
		id: SessionQueuedSubmission["id"]
	): SessionQueuedSubmission | undefined => {
		const queued = state.queuedSubmissions.find(
			(submission) => submission.id === id
		);
		if (queued === undefined) {
			return;
		}
		publish({
			queuedSubmissions: state.queuedSubmissions.filter(
				(submission) => submission.id !== id
			),
		});
		releaseQueuedAttachments([queued]);
		return queued;
	};
	const failQueuedSubmissionAttachments = (
		queued: SessionQueuedSubmission
	): SessionSendOutcome => {
		if (removeQueuedSubmission(queued.id) === undefined) {
			return isShutDown
				? { rejected: true, reason: SHUT_DOWN_SEND_ERROR }
				: { rejected: false };
		}
		const reason = isShutDown ? SHUT_DOWN_SEND_ERROR : QUEUED_ATTACHMENT_ERROR;
		reportSubmissionFailure(queued.input, queued.messageId, reason);
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
		const stillQueued = state.queuedSubmissions.some(
			(submission) => submission.id === queued.id
		);
		if (isShutDown || controller.signal.aborted || !stillQueued) {
			if (newAttachmentIds.length > 0) {
				ports.attachments.release(newAttachmentIds);
			}
			return isShutDown
				? { rejected: true, reason: SHUT_DOWN_SEND_ERROR }
				: { rejected: false };
		}
		if (newAttachmentIds.length > 0) {
			ports.attachments.retain(newAttachmentIds);
		}
		if (releasedAttachmentIds.length > 0) {
			ports.attachments.release(releasedAttachmentIds);
		}
		const updated: SessionQueuedSubmission = { ...queued, input };
		publish({
			queuedSubmissions: state.queuedSubmissions.map((submission) =>
				submission.id === queued.id ? updated : submission
			),
		});
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
			ports.attachments.retain(originalAttachmentIds);
		}
		const attachmentController = new AbortController();
		pendingAttachmentControllers.set(queued.id, attachmentController);
		publish({ queuedSubmissions: [...state.queuedSubmissions, queued] });
		const pending = finishQueuedSubmissionAttachments(
			queued,
			attachmentController,
			originalAttachmentIds
		);
		return pending.finally(() => {
			pendingAttachmentControllers.delete(queued.id);
			trackBackgroundTask(drainQueuedSubmissions());
		});
	};
	/**
	 * Accepts one submission into the Steering Lane of the running Agent Turn:
	 * a Steering Message carries text only, so nothing is materialised and
	 * nothing is hydrated — it waits exactly as it was composed and travels at
	 * the next Model Step boundary.
	 */
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
		const submissionId =
			input.submissionId ?? toSubmissionId(`submission-${crypto.randomUUID()}`);
		const messageId =
			input.reservedMessageId ??
			toSessionMessageId(`msg-${crypto.randomUUID()}`);
		const turnId =
			input.turnId ??
			primaryEntry(state.executions)?.turnId ??
			createAgentTurnId();
		const steering: SessionSteeringMessage = {
			id: toSteeringMessageId(crypto.randomUUID()),
			input: {
				agent: input.agent,
				// The message carries text only, so its composition travels back
				// to the composer exactly as it was composed.
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
		publish({ steeringMessages: [...state.steeringMessages, steering] });
		return {
			rejected: false,
			disposition: "steering",
			messageId,
			submissionId,
			turnId,
		};
	};
	const waitingMessageMatches = (
		ids: readonly SessionWaitingMessageId[] | undefined,
		id: SessionWaitingMessageId,
		submissionId: SessionWaitingMessageId | undefined
	): boolean =>
		isUndefined(ids) ||
		ids.includes(id) ||
		(submissionId !== undefined && ids.includes(submissionId));
	const emitRecalledSubmission = (message: SessionWaitingMessage): void => {
		const messageId =
			"messageId" in message ? message.messageId : message.input.messageId;
		const submissionId =
			"submissionId" in message
				? message.submissionId
				: message.input.submissionId;
		if (messageId === undefined || submissionId === undefined) {
			return;
		}
		emitSubmissionEvent({
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
		});
	};
	const recallWaitingMessages = (
		ids?: readonly SessionWaitingMessageId[]
	): SessionWaitingMessage[] => {
		const steering = state.steeringMessages.filter((message) =>
			waitingMessageMatches(ids, message.id, message.input.submissionId)
		);
		const queued = state.queuedSubmissions.filter((submission) =>
			waitingMessageMatches(ids, submission.id, submission.submissionId)
		);
		if (steering.length === 0 && queued.length === 0) {
			return [];
		}
		publish({
			queuedSubmissions: state.queuedSubmissions.filter(
				(submission) => !queued.includes(submission)
			),
			steeringMessages: state.steeringMessages.filter(
				(message) => !steering.includes(message)
			),
		});
		for (const submission of queued) {
			pendingAttachmentControllers.get(submission.id)?.abort();
		}
		releaseQueuedAttachments(queued);
		for (const message of [...steering, ...queued]) {
			emitRecalledSubmission(message);
		}
		return [...steering, ...queued];
	};
	/**
	 * Whether a submission is held instead of run now: the lane is taken, the
	 * queue is already being walked, work the next submission would wait for is
	 * in flight, or waiting submissions are already here.
	 */
	const queuesSubmission = (): boolean =>
		laneRuns > 0 ||
		draining ||
		state.turnActive ||
		state.isCompacting ||
		compactionCommand !== undefined ||
		activeOverflowRecoveries > 0 ||
		pendingAttachmentControllers.size > 0 ||
		state.queuedSubmissions.length > 0;
	const prepareAdmission = (
		input: SessionSendInput,
		composition: SessionSubmissionComposition
	): {
		admittedInput: SessionSendInput;
		messageId: SessionMessageId;
		submissionId: SubmissionId;
		turnId: AgentTurnId;
	} => {
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
		if (isShutDown) {
			return { rejected: true, reason: SHUT_DOWN_SEND_ERROR };
		}
		const composition: SessionSubmissionComposition = input.composition ?? {
			files: input.files ?? [],
			text: input.userText ?? "",
		};
		const { admittedInput, messageId, submissionId, turnId } = prepareAdmission(
			input,
			composition
		);
		if (queuesSubmission()) {
			const queued = acceptQueuedSubmission(admittedInput);
			trackBackgroundTask(queued);
			return {
				rejected: false,
				disposition: "queued",
				messageId,
				submissionId,
				turnId,
			};
		}
		void runSubmission(admittedInput).catch(() => undefined);
		return {
			rejected: false,
			disposition: "started",
			messageId,
			submissionId,
			turnId,
		};
	};
	const steer = (text: string): SessionSteeringAdmission => {
		if (isShutDown) {
			return { rejected: true, reason: SHUT_DOWN_SEND_ERROR };
		}
		const execution = primaryEntry(state.executions);
		if (!acceptsSteeringMessages(state) || execution === undefined) {
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
	/**
	 * The Agent Session's compatibility `send()` entry point. A submission that
	 * arrives while it is running joins the Steering Lane or Submission Queue.
	 */
	const send = async (input: SessionSendInput): Promise<SessionSendOutcome> => {
		if (isShutDown) {
			return { rejected: true, reason: SHUT_DOWN_SEND_ERROR };
		}
		if (acceptsSteeringMessages(state)) {
			const outcome = acceptSteeringMessage(input);
			return outcome.rejected ? outcome : { rejected: false };
		}
		if (queuesSubmission()) {
			const queued = acceptQueuedSubmission(input);
			trackBackgroundTask(queued);
			return await queued;
		}
		return await runSubmission(input);
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
		if (isShutDown) {
			return { kind: "rejected", reason: SHUT_DOWN_SEND_ERROR };
		}
		if (
			laneRuns > 0 ||
			draining ||
			state.turnActive ||
			state.isCompacting ||
			compactionCommand !== undefined ||
			activeOverflowRecoveries > 0 ||
			pendingAttachmentControllers.size > 0
		) {
			return {
				kind: "rejected",
				reason: "The Agent Session is busy.",
			};
		}
		fallbackSteeringMessages();
		const waiting = state.queuedSubmissions[0];
		if (waiting !== undefined) {
			trackBackgroundTask(drainQueuedSubmissions());
			return {
				kind: "started-submission",
				messageId: waiting.messageId,
				submissionId: waiting.submissionId,
				...omitUndefined({ turnId: waiting.input.turnId }),
			};
		}
		const messages = findContinuationContextMessages(state.context);
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
		contextContinuationInputs.add(continuation.input);
		void runSubmission(continuation.input).catch(() => undefined);
		return { kind: "resumed", turnId: continuation.turnId };
	};
	const interruptAll = (): SessionInterruptResult => {
		const approvalsSettled = state.approvals.filter(
			(approval) => approval.decision === undefined
		).length;
		const hasCompaction = state.isCompacting || compactionCommand !== undefined;
		const hasTurn =
			state.turnActive ||
			laneRuns > 0 ||
			state.executions.length > 0 ||
			activeOverflowRecoveries > 0;
		let kind: SessionInterruptResult["kind"] = "none";
		if (hasCompaction) {
			kind = "compaction";
		} else if (hasTurn) {
			kind = "turn";
		}
		closeApprovals();
		if (hasCompaction) {
			compactionCommand?.abort();
			setCompacting(false);
			if (!hasTurn) {
				interruptEpoch += 1;
			}
		}
		if (hasTurn) {
			interruptActiveWork();
		}
		const recalled = recallWaitingMessages();
		return { approvalsSettled, kind, recalled };
	};
	const hasPendingWork = (): boolean =>
		laneRuns > 0 ||
		draining ||
		compactionCommand !== undefined ||
		pendingCompactions.size > 0 ||
		pendingApprovals.size > 0 ||
		pendingDurableWrites.size > 0 ||
		pendingBackgroundTasks.size > 0 ||
		activeOverflowRecoveries > 0 ||
		pendingAttachmentControllers.size > 0 ||
		state.turnActive ||
		state.isCompacting ||
		state.executions.length > 0;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise !== undefined) {
			return shutdownPromise;
		}
		isShutDown = true;
		shutdownController.abort();
		for (const controller of pendingAttachmentControllers.values()) {
			controller.abort();
		}
		// Whatever was waiting is dropped with the session: its attachment
		// holds end and nothing it held is ever run.
		recallWaitingMessages();
		operation.cancel();
		closeApprovals();
		const compaction = compactionCommand?.promise;
		shutdownPromise = waitForShutdownWork(
			(async () => {
				const operationIdle = operation.waitForIdle();
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
				await operationIdle;
				await compactionSettled;
				await waitForBackgroundTasks();
				await waitForCompactions();
				await waitForDurableWrites();
			})()
		);
		return shutdownPromise;
	};

	return {
		continue: continueSession,
		abortApprovalTurn: (toolCallId) => {
			closeApprovals();
			interruptActiveWork(toolCallId);
		},
		applyContext,
		commitRecord,
		beginExecution,
		cancel: () => {
			interruptEpoch += 1;
			operation.cancel();
		},
		cancelCompaction: () => {
			if (
				compactionCommand !== undefined ||
				state.isCompacting ||
				activeOverflowRecoveries > 0
			) {
				interruptEpoch += 1;
			}
			compactionCommand?.abort();
			setCompacting(false);
			return recallWaitingMessages();
		},
		closeApprovals,
		compact,
		hasPendingWork,
		endExecution,
		getSnapshot: () => state,
		interrupt: (preserveToolCallId) => {
			closeApprovals();
			interruptActiveWork(preserveToolCallId);
			return recallWaitingMessages();
		},
		interruptAll,
		mergeTranscript,
		recallWaitingMessages,
		recoverOverflow,
		requestApproval,
		respondToApproval: settleApproval,
		setExecutionViewState,
		settleCompaction,
		prompt,
		onSubmissionEvent: (listener) => {
			submissionListeners.add(listener);
			return () => submissionListeners.delete(listener);
		},
		shutdown,
		send,
		steer,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};

import type { AgentTurnId, SessionMessageId } from "@wincode/agent-core";
import {
	getErrorMessage,
	isError,
	isNull,
	isUndefined,
	type LogFields,
	logger,
	omitUndefined,
} from "@wincode/utils";
import type { SessionId } from "@/shared/identifiers";
import type {
	CompactSessionInput,
	CompactSessionResult,
} from "../compaction/compaction";
import { SessionCompactionError } from "../compaction/error";
import {
	isContextOverflowFailure,
	type OverflowContinuationSource,
	OverflowRecoveryError,
	prepareOverflowContinuationSource,
	prepareOverflowRecoveryMessages,
} from "../compaction/overflow-recovery";
import type { SessionMessage } from "../message";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "../session-retry";
import { getReportableSessionFailureFields } from "./session-error-diagnostics";
import type {
	SessionCompactionCommand,
	SessionCompactionPort,
	SessionOverflowContinuationOutcome,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionOverflowRecoveryTarget,
} from "./types";

const SESSION_SHUT_DOWN_ERROR = "The session has ended.";
const recoveryTitle = (
	trigger: SessionOverflowRecoveryCommand["trigger"]
): string =>
	trigger === "output-limit"
		? "Output-limit recovery"
		: "Context overflow recovery";
const continuationFailureGuidance = (title: string): string =>
	`${title} saved a compacted Session Context, but could not continue it. No new session was created, and completed tool effects were not replayed. Review the saved compaction and any completed tool results; do not resubmit the original request until its effects are checked.`;
const compactionDiagnosticFields = (
	command: SessionCompactionCommand,
	phase: "started" | "completed" | "failed"
): LogFields => ({
	operation: "session.compaction",
	phase,
	trigger: command.trigger,
	...omitUndefined({ turnId: command.turnId }),
});
const logCompactionFailure = (
	error: unknown,
	command: SessionCompactionCommand
): void => {
	const fields = getReportableSessionFailureFields(error);
	if (fields === null) {
		return;
	}
	const record = {
		...fields,
		...compactionDiagnosticFields(command, "failed"),
	};
	if (
		command.trigger === "manual" ||
		fields.errorCode === "persistence-failed"
	) {
		void logger.error("Session compaction failed", record);
	} else {
		void logger.warn("Session compaction failed", record);
	}
};
const logCompactionRecoveryFailure = (
	error: unknown,
	phase: "target-resolution" | "continuation",
	trigger: SessionOverflowRecoveryCommand["trigger"],
	turnId: AgentTurnId
): void => {
	const fields = getReportableSessionFailureFields(error);
	if (fields === null) {
		return;
	}
	void logger.warn(`${recoveryTitle(trigger)} failed`, {
		...fields,
		operation: "session.compaction.overflow",
		phase,
		trigger,
		turnId,
	});
};

/**
 * One compaction command the Agent Session is running. The Session stores and
 * transitions it; a compaction module only starts the command and reads it back
 * through {@link SessionMaintenanceSnapshot.activeCompaction}.
 */
export type SessionMaintenanceCommandState = {
	abort: () => void;
	readonly phase: "preparing" | "running" | "cancelling";
	promise: Promise<CompactSessionResult>;
	registered: Promise<void>;
};

/**
 * The Agent Session state one maintenance step reads, frozen at the moment it
 * reads it. Re-read after an await when the step must see newer state.
 */
export type SessionMaintenanceSnapshot = Readonly<{
	/** The command currently compacting, or undefined once it settled. */
	activeCompaction: SessionMaintenanceCommandState | undefined;
	/** The Session Context: what the next Agent Turn sends to the model. */
	context: readonly SessionMessage[];
	/** The overflow attempts already spent, and the epoch they belong to. */
	recovery: Readonly<{
		attempted: ReadonlySet<SessionMessageId>;
		epoch: symbol;
	}>;
	sessionId: SessionId;
	shutdownSignal: AbortSignal;
	/** The Session Transcript: what the user sees, including summarized history. */
	transcript: readonly SessionMessage[];
	/**
	 * This moment's Transcript with a command's own record update laid over it,
	 * so a caller that already appended a durable message compacts it too.
	 */
	withTranscriptOverlay: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
}>;

/**
 * The questions a frozen snapshot cannot answer, because they change while a
 * step is awaiting and the answer decides whether the step may continue.
 */
export type SessionMaintenanceSignals = Readonly<{
	/** Whether the Session ended. Ask again after every await. */
	closed: () => boolean;
	/** False once the Session ended or a later epoch replaced this attempt's. */
	recoveryCurrent: (epoch: symbol) => boolean;
}>;

/**
 * A state transition only the Agent Session may apply. A compaction module
 * proposes one; it never reaches into the state behind it.
 */
export type SessionMaintenanceTransition =
	| {
			kind: "compaction-started";
			command: SessionMaintenanceCommandState;
	  }
	| {
			kind: "compaction-phase";
			command: SessionMaintenanceCommandState;
			phase: SessionMaintenanceCommandState["phase"];
	  }
	| {
			kind: "compaction-settled";
			command: SessionMaintenanceCommandState;
	  }
	| {
			kind: "compaction-applied";
			result: CompactSessionResult;
	  }
	| {
			kind: "compaction-failed";
			error: Error;
	  }
	| {
			kind: "compaction-request-tracked";
			request: Promise<CompactSessionResult>;
	  }
	| {
			kind: "recovery-begun";
			messageId: SessionMessageId;
	  }
	| {
			kind: "recovery-released";
			messageId: SessionMessageId;
	  };

/** The work maintenance hands back to the Agent Session instead of performing. */
export type SessionMaintenanceEffects = Readonly<{
	/** Drains the Submission Queue once compaction frees the Session. */
	drainQueueInBackground: () => void;
	/** Resolves the compaction settings the selected Provider Model runs with. */
	resolveCompactionSettings: (
		model: CompactSessionInput["model"]
	) => Promise<CompactSessionInput["settings"]>;
	/** Tracks one recovery run so shutdown waits for it, then drains the queue. */
	runTrackedRecovery: <Result>(run: () => Promise<Result>) => Promise<Result>;
	/** Resolves after one Agent Turn Execution ends. */
	waitForExecutionEnd: (turnId: AgentTurnId) => Promise<void>;
}>;

/**
 * The Agent Session as maintenance sees it: five keys. What it may read, what
 * it must ask again, what it may ask for, the compaction module it runs, and
 * the effects it hands back.
 */
export type SessionMaintenancePort = Readonly<{
	apply: (transition: SessionMaintenanceTransition) => void;
	compaction: SessionCompactionPort;
	effects: SessionMaintenanceEffects;
	read: () => SessionMaintenanceSnapshot;
	signals: () => SessionMaintenanceSignals;
}>;

/** Compaction and overflow-recovery orchestration without a second state owner. */
export type SessionMaintenanceWorkflow = Readonly<{
	cancelCompaction: () => void;
	compact: (command: SessionCompactionCommand) => Promise<CompactSessionResult>;
	recoverOverflow: (
		command: SessionOverflowRecoveryCommand
	) => Promise<SessionOverflowRecoveryOutcome>;
	settleCompaction: () => Promise<Error | null>;
}>;

/** Compaction and overflow-recovery orchestration without a second state owner. */
export const createSessionMaintenanceWorkflow = (
	port: SessionMaintenancePort
): SessionMaintenanceWorkflow => {
	const compactionSource = (
		command: SessionCompactionCommand,
		snapshot: SessionMaintenanceSnapshot
	): readonly SessionMessage[] => {
		if (!isUndefined(command.sourceMessages)) {
			return [...command.sourceMessages];
		}
		if (!isUndefined(command.nextMessages)) {
			return snapshot.withTranscriptOverlay(command.nextMessages);
		}
		return snapshot.transcript;
	};
	const compactionRequest = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[],
		signal: AbortSignal
	): Promise<CompactSessionInput> => ({
		model: command.model,
		session: { messages, sessionId: port.read().sessionId },
		settings: await port.effects.resolveCompactionSettings(command.model),
		trigger: command.trigger,
		...omitUndefined({
			focus: command.focus,
			protectedMessageIds: command.protectedMessageIds,
			thinkingLevel: command.thinkingLevel,
			turnId: command.turnId,
		}),
		signal,
	});
	const startCompaction = (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			port.read().shutdownSignal,
			...(command.signal === undefined ? [] : [command.signal]),
		]);
		const registration = Promise.withResolvers<void>();
		const { promise, reject, resolve } =
			Promise.withResolvers<CompactSessionResult>();
		const activeCommand: SessionMaintenanceCommandState = {
			abort: () => controller.abort(),
			phase: "preparing",
			promise,
			registered: registration.promise,
		};
		port.apply({ command: activeCommand, kind: "compaction-started" });
		void logger.debug(
			"Session compaction started",
			compactionDiagnosticFields(command, "started")
		);
		void (async () => {
			try {
				const request = await compactionRequest(command, messages, signal);
				if (signal.aborted || port.signals().closed()) {
					throw new SessionCompactionError(
						"cancelled",
						SESSION_SHUT_DOWN_ERROR
					);
				}
				const admitted = port.compaction.compact(request);
				port.apply({
					command: activeCommand,
					kind: "compaction-phase",
					phase: "running",
				});
				registration.resolve();
				const result = await admitted;
				// Durable persistence is the commit point; reconcile it before honoring later cancellation.
				port.apply({ kind: "compaction-applied", result });
				if (signal.aborted || port.signals().closed()) {
					throw new SessionCompactionError(
						"cancelled",
						SESSION_SHUT_DOWN_ERROR
					);
				}
				void logger.debug(
					"Session compaction completed",
					compactionDiagnosticFields(command, "completed")
				);
				resolve(result);
			} catch (error) {
				logCompactionFailure(error, command);
				registration.resolve();
				reject(error);
			} finally {
				port.apply({ command: activeCommand, kind: "compaction-settled" });
				port.effects.drainQueueInBackground();
			}
		})();
		return promise;
	};
	const joinCompaction = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const owner = port.read().activeCompaction;
		if (owner !== undefined) {
			await owner.registered;
			// Re-enter with whatever the Session now holds: this command either joins
			// the compaction that replaced its owner, or starts a fresh one.
			if (port.read().activeCompaction?.promise !== owner.promise) {
				return compact(command);
			}
		}
		if (port.signals().closed()) {
			throw new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR);
		}
		const request = await compactionRequest(
			command,
			messages,
			command.signal === undefined
				? port.read().shutdownSignal
				: AbortSignal.any([port.read().shutdownSignal, command.signal])
		);
		if (port.signals().closed()) {
			throw new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR);
		}
		if (
			owner !== undefined &&
			port.read().activeCompaction?.promise !== owner.promise
		) {
			return compact(command);
		}
		const result = await port.compaction.compact(request);
		if (owner !== undefined) {
			await owner.promise;
		}
		return result;
	};
	const compact = (
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		if (port.signals().closed()) {
			return Promise.reject(
				new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR)
			);
		}
		const snapshot = port.read();
		const messages = compactionSource(command, snapshot);
		const running =
			snapshot.activeCompaction ??
			port.compaction.getInFlight(snapshot.sessionId);
		const result = isNull(running)
			? startCompaction(command, messages)
			: joinCompaction(command, messages);
		port.apply({ kind: "compaction-request-tracked", request: result });
		return result;
	};
	const cancelCompaction = (): void => {
		const command = port.read().activeCompaction;
		if (command === undefined) {
			return;
		}
		command.abort();
		port.apply({
			command,
			kind: "compaction-phase",
			phase: "cancelling",
		});
	};
	const settleCompaction = async (): Promise<Error | null> => {
		while (true) {
			const command = port.read().activeCompaction;
			if (command === undefined) {
				return null;
			}
			try {
				await command.promise;
			} catch (error) {
				return isError(error) ? error : new Error("Session compaction failed.");
			}
		}
	};
	const recoveryError = (
		code: OverflowRecoveryError["code"],
		message: string,
		cause: unknown
	): OverflowRecoveryError =>
		new OverflowRecoveryError(code, message, { cause });
	const failRecovery = (
		error: OverflowRecoveryError
	): SessionOverflowRecoveryOutcome => {
		if (!port.signals().closed()) {
			port.apply({ error, kind: "compaction-failed" });
		}
		return { kind: "failed", error };
	};
	const runOverflowRecovery = async (
		command: SessionOverflowRecoveryCommand
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery owns independent eligibility, compaction, and continuation failure boundaries.
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (
			command.trigger === "context-overflow" &&
			!isContextOverflowFailure(command.error)
		) {
			return { kind: "ineligible" };
		}
		const title = recoveryTitle(command.trigger);
		const opening = port.read();
		if (opening.recovery.attempted.has(command.originalMessageId)) {
			return { kind: "exhausted" };
		}
		const originalMessageIndex = opening.context.findIndex(
			(message) =>
				message.id === command.originalMessageId && message.role === "user"
		);
		const attemptMessages =
			originalMessageIndex === -1
				? []
				: getSessionAttemptMessages(opening.context, originalMessageIndex);
		/**
		 * Completed tools make prompt replay unsafe. Recovery instead compacts
		 * older history and protects the newest settled assistant/tool batch.
		 */
		const usesContinuation = hasCompletedToolArtifact(attemptMessages);
		const recoveryEpoch = port.read().recovery.epoch;
		port.apply({
			kind: "recovery-begun",
			messageId: command.originalMessageId,
		});
		let target: SessionOverflowRecoveryTarget | null;
		try {
			target = await command.resolveTarget();
		} catch (error) {
			if (!port.signals().recoveryCurrent(recoveryEpoch)) {
				return { kind: "ineligible" };
			}
			logCompactionRecoveryFailure(
				error,
				"target-resolution",
				command.trigger,
				command.turnId
			);
			return failRecovery(
				recoveryError(
					"compaction-failed",
					`${title} could not resolve its compaction settings. No compaction was committed. No new session was created, and completed tool effects were not replayed. Review the existing Session and model settings before continuing manually.`,
					error
				)
			);
		}
		if (isNull(target)) {
			port.apply({
				kind: "recovery-released",
				messageId: command.originalMessageId,
			});
			return { kind: "ineligible" };
		}
		if (!port.signals().recoveryCurrent(recoveryEpoch)) {
			return { kind: "ineligible" };
		}
		// Snapshot the durable source after target resolution, so work settled
		// while the settings loaded is compacted instead of being dropped.
		let recoverySource: OverflowContinuationSource | null = null;
		if (usesContinuation) {
			recoverySource = prepareOverflowContinuationSource(
				port.read().transcript
			);
			if (recoverySource === null) {
				return { kind: "ineligible" };
			}
		}
		let result: CompactSessionResult;
		try {
			result = await compact({
				model: target.model,
				sourceMessages:
					recoverySource?.sourceMessages ??
					prepareOverflowRecoveryMessages(
						port.read().transcript,
						command.originalMessageId
					),
				trigger: "overflow",
				turnId: command.turnId,
				...omitUndefined({
					protectedMessageIds: recoverySource?.protectedMessageIds,
					thinkingLevel: target.thinkingLevel,
				}),
			});
		} catch (error) {
			if (!port.signals().recoveryCurrent(recoveryEpoch)) {
				return { kind: "ineligible" };
			}
			const detail = getErrorMessage(error, "");
			const reason =
				detail.length === 0
					? "The existing history could not be summarized safely."
					: detail;
			return failRecovery(
				recoveryError(
					"compaction-failed",
					`${title} could not compact this session: ${reason} No compaction was committed. No new session was created, and completed tool effects were not replayed. Review the existing Session and its tool results, reduce context or correct the compaction settings, then continue manually.`,
					error
				)
			);
		}
		await port.effects.waitForExecutionEnd(command.turnId);
		if (!port.signals().recoveryCurrent(recoveryEpoch)) {
			return { kind: "ineligible" };
		}
		let continuationOutcome: SessionOverflowContinuationOutcome;
		try {
			continuationOutcome = await command.continueContext({
				originalMessageId: command.originalMessageId,
			});
		} catch (error) {
			if (!port.signals().recoveryCurrent(recoveryEpoch)) {
				return { kind: "ineligible" };
			}
			logCompactionRecoveryFailure(
				error,
				"continuation",
				command.trigger,
				command.turnId
			);
			return failRecovery(
				recoveryError(
					"continuation-failed",
					continuationFailureGuidance(title),
					error
				)
			);
		}
		if (!port.signals().recoveryCurrent(recoveryEpoch)) {
			return { kind: "ineligible" };
		}
		if (continuationOutcome.kind === "refused") {
			const error = new OverflowRecoveryError(
				"continuation-refused",
				`${title} saved a compacted Session Context, but continuation was refused: ${continuationOutcome.reason}. No new session was created, and completed tool effects were not replayed. Review the saved compaction and any completed tool results; do not resubmit the original request until its effects are checked.`,
				{
					cause:
						command.trigger === "context-overflow" ? command.error : undefined,
				}
			);
			logCompactionRecoveryFailure(
				error,
				"continuation",
				command.trigger,
				command.turnId
			);
			return failRecovery(error);
		}
		if (continuationOutcome.kind === "failed") {
			const error = new OverflowRecoveryError(
				"continuation-failed",
				continuationFailureGuidance(title),
				{
					cause:
						command.trigger === "context-overflow" ? command.error : undefined,
				}
			);
			logCompactionRecoveryFailure(
				error,
				"continuation",
				command.trigger,
				command.turnId
			);
			return failRecovery(error);
		}
		return { kind: "recovered", entry: result.entry };
	};
	const recoverOverflow = (
		command: SessionOverflowRecoveryCommand
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (port.signals().closed()) {
			return Promise.resolve({ kind: "ineligible" });
		}
		return port.effects.runTrackedRecovery(() => runOverflowRecovery(command));
	};
	return {
		cancelCompaction,
		compact,
		recoverOverflow,
		settleCompaction,
	};
};

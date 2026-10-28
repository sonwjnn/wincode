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

/** Active compaction metadata remains stored and transitioned by Agent Session. */
export type SessionMaintenanceCommandState = {
	abort: () => void;
	phase: "preparing" | "running" | "cancelling" | "settled";
	promise: Promise<CompactSessionResult>;
	registered: Promise<void>;
};

export type SessionMaintenanceSessionState = Readonly<{
	closed: boolean;
	id: SessionId;
	shutdownSignal: AbortSignal;
}>;

export type SessionMaintenanceCommandTransition =
	| {
			kind: "started";
			command: SessionMaintenanceCommandState;
	  }
	| {
			kind: "phase";
			command: SessionMaintenanceCommandState;
			phase: SessionMaintenanceCommandState["phase"];
	  }
	| { kind: "settled"; command: SessionMaintenanceCommandState };

/** Narrow state/effect capabilities supplied by the authoritative Agent Session. */
export type SessionMaintenancePort = Readonly<{
	applyCompactionResult: (result: CompactSessionResult) => void;
	compaction: SessionCompactionPort;
	drainQueueInBackground: () => void;
	getActiveCompaction: () => SessionMaintenanceCommandState | undefined;
	getContext: () => readonly SessionMessage[];
	hasAttemptedRecovery: (messageId: SessionMessageId) => boolean;
	getSessionState: () => SessionMaintenanceSessionState;
	getTranscript: () => readonly SessionMessage[];
	isRecoveryCurrent: (generation: number) => boolean;
	mergeTranscript: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
	releaseRecoveryAttempt: (messageId: SessionMessageId) => void;
	resolveCompactionSettings: (
		model: CompactSessionInput["model"]
	) => Promise<CompactSessionInput["settings"]>;
	runTrackedOverflowRecovery: <T>(run: () => Promise<T>) => Promise<T>;
	setCompactionError: (error: Error | null) => void;
	startRecoveryAttempt: (messageId: SessionMessageId) => number;
	trackCompactionRequest: (
		request: Promise<CompactSessionResult>
	) => Promise<CompactSessionResult>;
	transitionCompactionCommand: (
		transition: SessionMaintenanceCommandTransition
	) => void;
	waitForExecutionEnd: (turnId: AgentTurnId) => Promise<void>;
}>;

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
		command: SessionCompactionCommand
	): readonly SessionMessage[] => {
		if (!isUndefined(command.sourceMessages)) {
			return [...command.sourceMessages];
		}
		if (!isUndefined(command.nextMessages)) {
			return port.mergeTranscript(command.nextMessages);
		}
		return port.getTranscript();
	};
	const compactionRequest = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[],
		signal: AbortSignal
	): Promise<CompactSessionInput> => ({
		model: command.model,
		session: { messages, sessionId: port.getSessionState().id },
		settings: await port.resolveCompactionSettings(command.model),
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
			port.getSessionState().shutdownSignal,
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
		port.transitionCompactionCommand({
			kind: "started",
			command: activeCommand,
		});
		void logger.debug(
			"Session compaction started",
			compactionDiagnosticFields(command, "started")
		);
		void (async () => {
			try {
				const request = await compactionRequest(command, messages, signal);
				if (signal.aborted || port.getSessionState().closed) {
					throw new SessionCompactionError(
						"cancelled",
						SESSION_SHUT_DOWN_ERROR
					);
				}
				const admitted = port.compaction.compact(request);
				port.transitionCompactionCommand({
					kind: "phase",
					command: activeCommand,
					phase: "running",
				});
				registration.resolve();
				const result = await admitted;
				// Durable persistence is the commit point; reconcile it before honoring later cancellation.
				port.applyCompactionResult(result);
				if (signal.aborted || port.getSessionState().closed) {
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
				port.transitionCompactionCommand({
					kind: "settled",
					command: activeCommand,
				});
				port.drainQueueInBackground();
			}
		})();
		return promise;
	};
	const joinCompaction = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const owner = port.getActiveCompaction();
		if (owner !== undefined) {
			await owner.registered;
			if (owner.phase === "settled") {
				return compact(command);
			}
		}
		if (port.getSessionState().closed) {
			throw new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR);
		}
		const request = await compactionRequest(
			command,
			messages,
			command.signal === undefined
				? port.getSessionState().shutdownSignal
				: AbortSignal.any([
						port.getSessionState().shutdownSignal,
						command.signal,
					])
		);
		if (port.getSessionState().closed) {
			throw new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR);
		}
		if (owner !== undefined && owner.phase === "settled") {
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
		if (port.getSessionState().closed) {
			return Promise.reject(
				new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR)
			);
		}
		const messages = compactionSource(command);
		const running =
			port.getActiveCompaction() ??
			port.compaction.getInFlight(port.getSessionState().id);
		const result = isNull(running)
			? startCompaction(command, messages)
			: joinCompaction(command, messages);
		return port.trackCompactionRequest(result);
	};
	const cancelCompaction = (): void => {
		const command = port.getActiveCompaction();
		if (command === undefined) {
			return;
		}
		command.abort();
		port.transitionCompactionCommand({
			kind: "phase",
			command,
			phase: "cancelling",
		});
	};
	const settleCompaction = async (): Promise<Error | null> => {
		while (true) {
			const command = port.getActiveCompaction();
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
		if (!port.getSessionState().closed) {
			port.setCompactionError(error);
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
		if (port.hasAttemptedRecovery(command.originalMessageId)) {
			return { kind: "exhausted" };
		}
		const originalMessageIndex = port
			.getContext()
			.findIndex(
				(message) =>
					message.id === command.originalMessageId && message.role === "user"
			);
		const attemptMessages =
			originalMessageIndex === -1
				? []
				: getSessionAttemptMessages(port.getContext(), originalMessageIndex);
		/**
		 * Completed tools make prompt replay unsafe. Recovery instead compacts
		 * older history and protects the newest settled assistant/tool batch.
		 */
		const usesContinuation = hasCompletedToolArtifact(attemptMessages);
		const recoveryEpoch = port.startRecoveryAttempt(command.originalMessageId);
		let target: SessionOverflowRecoveryTarget | null;
		try {
			target = await command.resolveTarget();
		} catch (error) {
			if (!port.isRecoveryCurrent(recoveryEpoch)) {
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
			port.releaseRecoveryAttempt(command.originalMessageId);
			return { kind: "ineligible" };
		}
		if (!port.isRecoveryCurrent(recoveryEpoch)) {
			return { kind: "ineligible" };
		}
		// Snapshot the durable source after target resolution, so work settled
		// while the settings loaded is compacted instead of being dropped.
		let recoverySource: OverflowContinuationSource | null = null;
		if (usesContinuation) {
			recoverySource = prepareOverflowContinuationSource(port.getTranscript());
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
						port.getTranscript(),
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
			if (!port.isRecoveryCurrent(recoveryEpoch)) {
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
		await port.waitForExecutionEnd(command.turnId);
		if (!port.isRecoveryCurrent(recoveryEpoch)) {
			return { kind: "ineligible" };
		}
		let continuationOutcome: SessionOverflowContinuationOutcome;
		try {
			continuationOutcome = await command.continueContext({
				originalMessageId: command.originalMessageId,
			});
		} catch (error) {
			if (!port.isRecoveryCurrent(recoveryEpoch)) {
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
		if (!port.isRecoveryCurrent(recoveryEpoch)) {
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
		if (port.getSessionState().closed) {
			return Promise.resolve({ kind: "ineligible" });
		}
		return port.runTrackedOverflowRecovery(() => runOverflowRecovery(command));
	};
	return {
		cancelCompaction,
		compact,
		recoverOverflow,
		settleCompaction,
	};
};

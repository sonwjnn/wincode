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
import type { SessionCompaction } from "../compaction/types";
import type { SessionMessage } from "../message";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "../session-retry";
import { getReportableSessionFailureFields } from "./session-error-diagnostics";
import type {
	AgentSessionPorts,
	SessionCompactionCommand,
	SessionCompactionPort,
	SessionOverflowContinuationOutcome,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionOverflowRecoveryTarget,
} from "./types";

const SESSION_SHUT_DOWN_ERROR = "The session has ended.";
const CONTINUATION_FAILURE_GUIDANCE =
	"Context overflow recovery saved a compacted Session Context, but could not continue it. No new session was created, and completed tool effects were not replayed. Review the saved compaction and any completed tool results; do not resubmit the original request until its effects are checked.";
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
const logOverflowRecoveryFailure = (
	error: unknown,
	phase: "target-resolution" | "continuation",
	turnId: AgentTurnId
): void => {
	const fields = getReportableSessionFailureFields(error);
	if (fields === null) {
		return;
	}
	void logger.warn("Context overflow recovery failed", {
		...fields,
		operation: "session.compaction.overflow",
		phase,
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

/** Narrow state/effect capabilities supplied by the authoritative Agent Session. */
export type SessionMaintenancePort = Readonly<{
	addCompactionRequest: (request: Promise<CompactSessionResult>) => void;
	addRecoveryAttempt: (messageId: SessionMessageId) => void;
	hasAttemptedRecovery: (messageId: SessionMessageId) => boolean;
	addRecoveryRun: (id: symbol) => void;
	applyContext: (messages: readonly SessionMessage[]) => void;
	compaction: SessionCompactionPort;
	drainQueuedSubmissions: () => Promise<void>;
	finishCompactionCommand: (command: SessionMaintenanceCommandState) => void;
	getActiveCompaction: () => SessionMaintenanceCommandState | undefined;
	getContext: () => readonly SessionMessage[];
	getRecoveryGeneration: () => number;
	getTranscript: () => readonly SessionMessage[];
	isClosed: () => boolean;
	mergeTranscript: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
	recordCompaction: (entry: SessionCompaction) => void;
	removeCompactionRequest: (request: Promise<CompactSessionResult>) => void;
	removeRecoveryAttempt: (messageId: SessionMessageId) => void;
	removeRecoveryRun: (id: symbol) => void;
	requestOverheadTokens: () => number;
	resolveCompactionSettings: AgentSessionPorts["resolveCompactionSettings"];
	setActiveCompaction: (command: SessionMaintenanceCommandState) => void;
	setCompactionError: (error: Error | null) => void;
	setCompactionPhase: (
		command: SessionMaintenanceCommandState,
		phase: SessionMaintenanceCommandState["phase"]
	) => void;
	shutdownSignal: AbortSignal;
	sessionId: SessionId;
	trackBackgroundTask: (task: Promise<unknown>) => void;
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
	const compactionSettingsFor = async (
		model: CompactSessionInput["model"]
	): Promise<CompactSessionInput["settings"]> => {
		const settings = await port.resolveCompactionSettings(model);
		return {
			...omitUndefined({
				contextWindowOverrideTokens: settings.contextWindowOverrideTokens,
				summary: settings.summary,
			}),
			compactionOverheadTokens: port.requestOverheadTokens(),
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
		session: { messages, sessionId: port.sessionId },
		settings: await compactionSettingsFor(command.model),
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
			port.shutdownSignal,
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
		port.setActiveCompaction(activeCommand);
		void logger.debug(
			"Session compaction started",
			compactionDiagnosticFields(command, "started")
		);
		void (async () => {
			try {
				const request = await compactionRequest(command, messages, signal);
				if (signal.aborted || port.isClosed()) {
					throw new SessionCompactionError(
						"cancelled",
						SESSION_SHUT_DOWN_ERROR
					);
				}
				const admitted = port.compaction.compact(request);
				port.setCompactionPhase(activeCommand, "running");
				registration.resolve();
				const result = await admitted;
				// Successful persistence is the commit point. Reconcile it even if cancellation won later.
				port.applyContext(result.activeMessages);
				port.recordCompaction(result.entry);
				port.setCompactionError(null);
				if (signal.aborted || port.isClosed()) {
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
				if (port.getActiveCompaction()?.promise === promise) {
					port.finishCompactionCommand(activeCommand);
				}
				port.trackBackgroundTask(port.drainQueuedSubmissions());
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
		if (port.isClosed()) {
			throw new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR);
		}
		const request = await compactionRequest(
			command,
			messages,
			command.signal === undefined
				? port.shutdownSignal
				: AbortSignal.any([port.shutdownSignal, command.signal])
		);
		if (port.isClosed()) {
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
	const trackPendingCompaction = (
		result: Promise<CompactSessionResult>
	): Promise<CompactSessionResult> => {
		port.addCompactionRequest(result);
		void (async () => {
			try {
				await result;
			} catch {
				// The compaction caller observes the original rejection.
			} finally {
				port.removeCompactionRequest(result);
			}
		})();
		return result;
	};
	const compact = (
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		if (port.isClosed()) {
			return Promise.reject(
				new SessionCompactionError("cancelled", SESSION_SHUT_DOWN_ERROR)
			);
		}
		const messages = compactionSource(command);
		const running =
			port.getActiveCompaction() ?? port.compaction.getInFlight(port.sessionId);
		const result = isNull(running)
			? startCompaction(command, messages)
			: joinCompaction(command, messages);
		return trackPendingCompaction(result);
	};
	const cancelCompaction = (): void => {
		const command = port.getActiveCompaction();
		if (command === undefined) {
			return;
		}
		command.abort();
		port.setCompactionPhase(command, "cancelling");
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
		if (!port.isClosed()) {
			port.setCompactionError(error);
		}
		return { kind: "failed", error };
	};
	const runOverflowRecovery = async (
		command: SessionOverflowRecoveryCommand
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery owns independent eligibility, compaction, and continuation failure boundaries.
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (!isContextOverflowFailure(command.error)) {
			return { kind: "ineligible" };
		}
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
		 * Completed tools make a prompt replay unsafe. Recovery then continues
		 * the durable context: older history is summarized and the newest
		 * settled assistant/tool batch stays intact.
		 */
		const usesContinuation = hasCompletedToolArtifact(attemptMessages);
		port.addRecoveryAttempt(command.originalMessageId);
		const recoveryEpoch = port.getRecoveryGeneration();
		let target: SessionOverflowRecoveryTarget | null;
		try {
			target = await command.resolveTarget();
		} catch (error) {
			if (port.isClosed() || recoveryEpoch !== port.getRecoveryGeneration()) {
				return { kind: "ineligible" };
			}
			logOverflowRecoveryFailure(error, "target-resolution", command.turnId);
			return failRecovery(
				recoveryError(
					"compaction-failed",
					"Context overflow recovery could not resolve its compaction settings. No compaction was committed. No new session was created, and completed tool effects were not replayed. Review the existing Session and model settings before continuing manually.",
					error
				)
			);
		}
		if (isNull(target)) {
			port.removeRecoveryAttempt(command.originalMessageId);
			return { kind: "ineligible" };
		}
		if (port.isClosed() || recoveryEpoch !== port.getRecoveryGeneration()) {
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
			if (port.isClosed() || recoveryEpoch !== port.getRecoveryGeneration()) {
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
					`Context overflow recovery could not compact this session: ${reason} No compaction was committed. No new session was created, and completed tool effects were not replayed. Review the existing Session and its tool results, reduce context or correct the compaction settings, then continue manually.`,
					error
				)
			);
		}
		await port.waitForExecutionEnd(command.turnId);
		if (port.isClosed() || recoveryEpoch !== port.getRecoveryGeneration()) {
			return { kind: "ineligible" };
		}
		let continuationOutcome: SessionOverflowContinuationOutcome;
		try {
			continuationOutcome = await command.continueContext({
				originalMessageId: command.originalMessageId,
			});
		} catch (error) {
			if (port.isClosed() || recoveryEpoch !== port.getRecoveryGeneration()) {
				return { kind: "ineligible" };
			}
			logOverflowRecoveryFailure(error, "continuation", command.turnId);
			return failRecovery(
				recoveryError(
					"continuation-failed",
					CONTINUATION_FAILURE_GUIDANCE,
					error
				)
			);
		}
		if (port.isClosed() || recoveryEpoch !== port.getRecoveryGeneration()) {
			return { kind: "ineligible" };
		}
		if (continuationOutcome.kind === "refused") {
			const error = new OverflowRecoveryError(
				"continuation-refused",
				`Context overflow recovery saved a compacted Session Context, but continuation was refused: ${continuationOutcome.reason}. No new session was created, and completed tool effects were not replayed. Review the saved compaction and any completed tool results; do not resubmit the original request until its effects are checked.`,
				{ cause: command.error }
			);
			logOverflowRecoveryFailure(error, "continuation", command.turnId);
			return failRecovery(error);
		}
		if (continuationOutcome.kind === "failed") {
			const error = new OverflowRecoveryError(
				"continuation-failed",
				CONTINUATION_FAILURE_GUIDANCE,
				{ cause: command.error }
			);
			logOverflowRecoveryFailure(error, "continuation", command.turnId);
			return failRecovery(error);
		}
		return { kind: "recovered", entry: result.entry };
	};
	const recoverOverflow = (
		command: SessionOverflowRecoveryCommand
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (port.isClosed()) {
			return Promise.resolve({ kind: "ineligible" });
		}
		const runId = Symbol("overflow-recovery-run");
		port.addRecoveryRun(runId);
		const recovery = runOverflowRecovery(command);
		const settleRecovery = (): void => {
			port.removeRecoveryRun(runId);
			port.trackBackgroundTask(port.drainQueuedSubmissions());
		};
		void recovery.then(settleRecovery, settleRecovery);
		return recovery;
	};
	return {
		cancelCompaction,
		compact,
		recoverOverflow,
		settleCompaction,
	};
};

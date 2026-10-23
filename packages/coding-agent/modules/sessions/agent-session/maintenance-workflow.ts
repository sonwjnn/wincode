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
	OverflowRecoveryError,
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
			thinkingLevel: command.thinkingLevel,
		}),
		signal,
	});
	const startCompaction = (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const controller = new AbortController();
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
				const request = await compactionRequest(
					command,
					messages,
					AbortSignal.any([
						controller.signal,
						port.getSessionState().shutdownSignal,
					])
				);
				if (controller.signal.aborted || port.getSessionState().closed) {
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
				if (controller.signal.aborted || port.getSessionState().closed) {
					throw new SessionCompactionError(
						"cancelled",
						SESSION_SHUT_DOWN_ERROR
					);
				}
				port.applyCompactionResult(result);
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
			port.getSessionState().shutdownSignal
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
		message: string,
		cause: unknown
	): OverflowRecoveryError =>
		new OverflowRecoveryError("continuation-failed", message, { cause });
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
		if (
			originalMessageIndex !== -1 &&
			hasCompletedToolArtifact(
				getSessionAttemptMessages(port.getContext(), originalMessageIndex)
			)
		) {
			return { kind: "ineligible" };
		}
		const recoveryEpoch = port.startRecoveryAttempt(command.originalMessageId);
		let target: SessionOverflowRecoveryTarget | null;
		try {
			target = await command.resolveTarget();
		} catch (error) {
			if (!port.isRecoveryCurrent(recoveryEpoch)) {
				return { kind: "ineligible" };
			}
			logOverflowRecoveryFailure(error, "target-resolution", command.turnId);
			return failRecovery(
				recoveryError(
					"Context overflow recovery could not resolve its compaction settings.",
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
		let result: CompactSessionResult;
		try {
			result = await compact({
				model: target.model,
				sourceMessages: prepareOverflowRecoveryMessages(
					port.getTranscript(),
					command.originalMessageId
				),
				trigger: "overflow",
				turnId: command.turnId,
				...omitUndefined({
					thinkingLevel: target.thinkingLevel,
				}),
			});
		} catch (error) {
			if (!port.isRecoveryCurrent(recoveryEpoch)) {
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
			logOverflowRecoveryFailure(error, "continuation", command.turnId);
			return failRecovery(
				recoveryError(
					"Context overflow recovery could not continue the compacted Session Context.",
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
				`Context overflow recovery could not continue the compacted Session Context: ${continuationOutcome.reason}`,
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

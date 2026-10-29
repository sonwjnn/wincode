import {
	type AgentId,
	type AgentTurn,
	type AgentTurnId,
	createAgentTurnAbortEvent,
	createAgentTurnId,
	getAgentTurnAbortDisposition,
	isOperationalFailure,
	type OperationalFailure,
	type SessionMessageId,
	type SessionRecord,
	toSessionMessageId,
} from "@wincode/agent-core";
import type { ThinkingLevel } from "@wincode/ai";
import {
	getErrorMessage,
	isError,
	isNull,
	isUndefined,
	logger,
	omitUndefined,
} from "@wincode/utils";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import {
	createSkillSnapshot,
	type SkillRequestContext,
} from "@/modules/skills";
import type { SessionId } from "@/shared/identifiers";
import { errorLogFields } from "@/shared/utils/error-log-fields";
import { logSessionPersistenceFailure } from "@/shared/utils/session-persistence-diagnostics";
import type { CompactSessionResult } from "../compaction/compaction";
import type { ResolvedCompactionSettings } from "../compaction/config";
import { SessionCompactionError } from "../compaction/error";
import {
	isContextOverflowFailure,
	isProviderReportedContextOverflow,
} from "../compaction/overflow-recovery";
import type { SessionViewState } from "../hooks/runtime-turn";
import {
	createSessionUserMessage,
	type SessionMessage,
	type SessionMessageMetadata,
	sanitizeSessionSkillToolParts,
} from "../message";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "../session-retry";
import { buildUserSessionRecord } from "../storage/session-record";
import type { SessionSendInput, SessionSendOutcome } from "../submission-types";
import {
	buildAssistantCancelledSessionRecord,
	buildAssistantFailureSessionRecord,
	buildTerminalSessionRecord,
} from "../turn-records";
import { getSessionContextEpoch } from "../usage/context-usage";
import { getReportableSessionFailureFields } from "./session-error-diagnostics";
import { SESSION_SHUT_DOWN_ERROR } from "./session-messages";
import { projectAgentTurnEvent, projectAgentTurnTerminal } from "./turn";
import type {
	AgentSessionPorts,
	SessionAttachmentBudget,
	SessionCompactionCommand,
	SessionExecution,
	SessionExecutionInput,
	SessionOverflowContinuationOutcome,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionSkillCatalog,
	SessionTurnCallbacks,
} from "./types";

/** The Agent Session state and commands one submission runs against. */
export type SubmissionDeps = Readonly<{
	applyContext: (messages: readonly SessionMessage[]) => void;
	beginExecution: (input: SessionExecutionInput) => SessionExecution;
	compact: (command: SessionCompactionCommand) => Promise<CompactSessionResult>;
	endExecution: (turnId: AgentTurnId) => void;
	getAssistantMessageId: (turnId: AgentTurnId) => SessionMessageId;
	getError: () => Error | null;
	finishModelStep: (
		turnId: AgentTurnId,
		record: SessionRecord | undefined
	) => void;
	isShutDown: () => boolean;
	/** Persists delivered Steering Message state transitions. */
	acknowledgeSteeringMessages: (
		turnId: AgentTurnId,
		status: "failed" | "processed",
		failure?: string
	) => Promise<void>;
	/** Returns only uncommitted queued input to the composer after turn failure. */
	recallFailedTurnMessages: (turnId: AgentTurnId) => void;
	getContext: () => readonly SessionMessage[];
	getTranscript: () => readonly SessionMessage[];
	mergeTranscript: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
	ports: AgentSessionPorts;
	recoverOverflow: (
		command: SessionOverflowRecoveryCommand
	) => Promise<SessionOverflowRecoveryOutcome>;
	continueContext: (
		input: SessionSendInput,
		onExecutionStarted: () => void
	) => Promise<SessionSendOutcome>;
	isContextContinuation: (input: SessionSendInput) => boolean;
	sessionId: SessionId;
	setCatalogDiagnostic: (diagnostic: string | null) => void;
	setCompactionError: (error: Error | null) => void;
	setError: (error: Error | null) => void;
	setExecutionViewState: (
		turnId: AgentTurnId,
		viewState: SessionViewState
	) => void;
	setRunPhase: (phase: "preparing" | "running" | "settling") => void;
	settleCompaction: () => Promise<Error | null>;
	/**
	 * Tracks maintenance and queue work that begins outside the active Agent
	 * Turn, so Host shutdown can wait before releasing ownership.
	 */
	trackBackgroundTask: (task: Promise<unknown>) => void;
	/**
	 * Takes durable Steering Messages at a Model Step boundary, persists their
	 * processing state and prepares attachments/Skill context for the runtime.
	 */
	takeSteeringMessages: (
		execution: SessionExecution,
		armedSkill: SessionSkillCatalog,
		signal: AbortSignal
	) => Promise<SessionMessage[]>;
}>;
class SessionClosedError extends Error {
	constructor() {
		super(SESSION_SHUT_DOWN_ERROR);
		this.name = "SessionClosedError";
	}
}
class SessionSendCancelledError extends Error {
	constructor() {
		super("The Session send was cancelled.");
		this.name = "SessionSendCancelledError";
	}
}

const assertSendNotCancelled = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new SessionSendCancelledError();
	}
};

const assertSessionOpen = (deps: Pick<SubmissionDeps, "isShutDown">): void => {
	if (deps.isShutDown()) {
		throw new SessionClosedError();
	}
};

type SubmitCompactionResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

type PreparedModelMessages =
	| { readonly kind: "cancelled" }
	| {
			readonly kind: "ready";
			readonly messages: SessionMessage[];
			readonly newMessage?: SessionMessage;
	  }
	| { readonly kind: "rejected"; readonly reason: string };

type SubmitContextResult =
	| {
			readonly kind: "ready";
			readonly anchoredMessage?: SessionMessage;
			/** The Skill catalog armed for the Agent Turn this submission starts. */
			readonly armedSkill: SessionSkillCatalog;
			readonly metadata: SessionMessageMetadata;
			readonly resolvedAgent: NonNullable<SessionSendInput["resolvedAgent"]>;
			readonly skill?: SkillRequestContext;
	  }
	| { readonly kind: "cancelled" }
	| { readonly kind: "rejected"; readonly reason: string };

type SessionPreparationResult =
	| { readonly kind: "cancelled" }
	| {
			readonly error?: Error;
			readonly kind: "rejected";
			readonly reason: string;
	  }
	| {
			readonly attachmentBudget: SessionAttachmentBudget;
			readonly context: Extract<SubmitContextResult, { kind: "ready" }>;
			readonly kind: "ready";
			readonly messages: SessionMessage[];
			readonly newMessage?: SessionMessage;
	  };

/** Another compaction already carries the work this request asked for. */
const isInFlightCompaction = (error: unknown): boolean =>
	error instanceof SessionCompactionError && error.code === "in-flight";

/** The reason a compaction failure blocks a submission, or null when it does not. */
const compactionFailureReason = (error: unknown): string | null =>
	isBenignCompactionError(error)
		? null
		: getErrorMessage(error, "Session compaction failed.");

const isBenignCompactionError = (error: unknown): boolean =>
	error instanceof SessionCompactionError &&
	(error.code === "history-too-short" || error.code === "not-needed");

/**
 * The outcome for a threshold compaction that failed or was refused. A refusal
 * because another caller owns the compaction is joined here, through the same
 * settle a preparation takes, and returns null so the caller re-checks the
 * threshold against the settled Session Context instead of dropping the turn.
 */
const thresholdCompactionFailure = async (
	cause: unknown,
	settleCompaction: () => Promise<Error | null>
): Promise<SubmitCompactionResult | null> => {
	if (!isInFlightCompaction(cause)) {
		const reason = compactionFailureReason(cause);
		return isNull(reason) ? { ok: true } : { ok: false, reason };
	}
	const joinedError = await settleCompaction();
	const joinedReason = isNull(joinedError)
		? null
		: compactionFailureReason(joinedError);
	return isNull(joinedReason) ? null : { ok: false, reason: joinedReason };
};

/** Whether the Session Context needs a threshold compaction under these settings. */
const needsThresholdCompaction = (
	compaction: AgentSessionPorts["compaction"],
	messages: readonly SessionMessage[],
	settings: ResolvedCompactionSettings,
	model: ProviderModelSelection
): boolean =>
	settings.autoAvailable &&
	compaction.needsCompaction(messages, settings, model);

const getContextCompactionTrigger = (
	compaction: AgentSessionPorts["compaction"],
	messages: readonly SessionMessage[],
	settings: ResolvedCompactionSettings,
	model: ProviderModelSelection,
	providerInputTokens: number | null
): "overflow" | "threshold" | null => {
	if (
		settings.overflowRecoveryAvailable &&
		isProviderReportedContextOverflow(
			providerInputTokens,
			settings.modelContextLimit
		)
	) {
		return "overflow";
	}
	return needsThresholdCompaction(compaction, messages, settings, model)
		? "threshold"
		: null;
};

export const prepareCompactionBeforeSubmit = async ({
	compaction,
	getActiveMessages,
	model,
	runCompaction,
	settings,
	settleCompaction,
	turnId,
	thinkingLevel,
}: {
	compaction: AgentSessionPorts["compaction"];
	getActiveMessages: () => readonly SessionMessage[];
	model: ProviderModelSelection;
	runCompaction: (
		command: SessionCompactionCommand
	) => Promise<CompactSessionResult>;
	settings: ResolvedCompactionSettings;
	settleCompaction: () => Promise<Error | null>;
	turnId?: AgentTurnId;
	thinkingLevel?: ThinkingLevel;
}): Promise<SubmitCompactionResult> => {
	// The threshold this Agent Turn needs has to hold on the Session Context it
	// sends, so a compaction another caller owns is joined and the need
	// re-checked against the settled context rather than raced.
	while (true) {
		if (
			!needsThresholdCompaction(
				compaction,
				getActiveMessages(),
				settings,
				model
			)
		) {
			return { ok: true };
		}
		try {
			await runCompaction({
				model,
				trigger: "threshold",
				...omitUndefined({ turnId, thinkingLevel }),
			});
			return { ok: true };
		} catch (cause) {
			const outcome = await thresholdCompactionFailure(cause, settleCompaction);
			if (isNull(outcome)) {
				continue;
			}
			return outcome;
		}
	}
};

const createSubmitMetadata = (
	input: SessionSendInput,
	skill: SkillRequestContext | undefined
): SessionMessageMetadata => ({
	agent: input.agent,
	model: input.model,
	...omitUndefined({
		thinkingLevel: input.thinkingLevel,
		submissionId: input.submissionId,
		skill: isUndefined(skill)
			? undefined
			: createSkillSnapshot(skill, "explicit"),
	}),
});

const prepareSubmitContext = async ({
	activeMessages,
	armSkill,
	input,
	isContextContinuation,
	resolveSkill,
	signal,
}: {
	activeMessages: readonly SessionMessage[];
	armSkill: (
		agentId: AgentId,
		signal: AbortSignal
	) => Promise<SessionSkillCatalog>;
	input: SessionSendInput;
	isContextContinuation: boolean;
	resolveSkill: AgentSessionPorts["skills"]["resolveSkill"];
	signal: AbortSignal;
}): Promise<SubmitContextResult> => {
	const armedSkill = await armSkill(input.agent, signal);
	if (signal.aborted) {
		return { kind: "cancelled" };
	}
	const resolvedAgent = input.resolvedAgent;
	if (isUndefined(resolvedAgent)) {
		return {
			kind: "rejected",
			reason: "The resolved Agent is unavailable.",
		};
	}
	const anchoredMessage = isUndefined(input.messageId)
		? undefined
		: activeMessages.find(({ id }) => id === input.messageId);
	// A continuation of the existing context keeps its originating user message
	// only for bookkeeping; compaction may already have summarized it away.
	if (
		!isUndefined(input.messageId) &&
		anchoredMessage?.role !== "user" &&
		!(isContextContinuation && isUndefined(anchoredMessage))
	) {
		return {
			kind: "rejected",
			reason: "The stored message to continue is unavailable",
		};
	}
	const skillResolution = await resolveSkill(
		input.skill,
		anchoredMessage,
		armedSkill
	);
	if (!skillResolution.ok) {
		return { kind: "rejected", reason: skillResolution.reason };
	}
	return {
		anchoredMessage,
		armedSkill,
		kind: "ready",
		metadata: createSubmitMetadata(input, skillResolution.skill),
		resolvedAgent,
		skill: skillResolution.skill,
	};
};

const prepareNewSessionMessage = async ({
	externalize,
	input,
	metadata,
	resolveFileMentions,
	signal,
}: {
	externalize: AgentSessionPorts["attachments"]["externalize"];
	input: SessionSendInput;
	metadata: SessionMessageMetadata;
	resolveFileMentions: AgentSessionPorts["resolveFileMentions"];
	signal: AbortSignal;
}): Promise<
	| { readonly kind: "ready"; readonly message: SessionMessage }
	| { readonly kind: "cancelled" }
	| { readonly kind: "rejected"; readonly reason: string }
> => {
	const userText = input.userText;
	if (isUndefined(userText)) {
		return { kind: "rejected", reason: "No prompt to submit" };
	}
	const fileMentions = await resolveFileMentions(userText);
	const optimistic = createSessionUserMessage(
		userText,
		metadata,
		fileMentions,
		input.files ?? [],
		input.reservedMessageId ?? input.messageId
	);
	try {
		const [externalized] = await externalize([optimistic], signal);
		return { kind: "ready", message: externalized ?? optimistic };
	} catch {
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		return {
			kind: "rejected",
			reason: "Attachment data could not be stored.",
		};
	}
};

export const prepareRetryMessages = (
	messages: readonly SessionMessage[],
	messageId: SessionMessageId
): PreparedModelMessages => {
	const messageIndex = messages.findIndex(
		(message) => message.id === messageId && message.role === "user"
	);
	if (messageIndex === -1) {
		return {
			kind: "rejected",
			reason: "The stored message to continue is unavailable",
		};
	}
	if (
		hasCompletedToolArtifact(getSessionAttemptMessages(messages, messageIndex))
	) {
		return {
			kind: "rejected",
			reason: "This message cannot be retried after completed Tool Calls.",
		};
	}
	return {
		kind: "ready",
		messages: sanitizeSessionSkillToolParts(
			messages.filter(
				(message) =>
					message.role !== "assistant" ||
					(message.metadata?.interrupted !== true &&
						isUndefined(message.metadata?.terminalOutcome))
			)
		),
	};
};

const prepareModelMessages = async ({
	activeMessages,
	context,
	externalize,
	input,
	isContextContinuation,
	resolveFileMentions,
	signal,
}: {
	activeMessages: readonly SessionMessage[];
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	externalize: AgentSessionPorts["attachments"]["externalize"];
	input: SessionSendInput;
	isContextContinuation: boolean;
	resolveFileMentions: AgentSessionPorts["resolveFileMentions"];
	signal: AbortSignal;
}): Promise<PreparedModelMessages> => {
	if (isContextContinuation) {
		return {
			kind: "ready",
			messages: sanitizeSessionSkillToolParts(activeMessages),
		};
	}
	if (!(isUndefined(context.anchoredMessage) || isUndefined(input.messageId))) {
		return prepareRetryMessages(activeMessages, input.messageId);
	}

	const preparedMessage = await prepareNewSessionMessage({
		externalize,
		input,
		metadata: context.metadata,
		resolveFileMentions,
		signal,
	});
	if (preparedMessage.kind !== "ready") {
		return preparedMessage;
	}
	return {
		kind: "ready",
		messages: [
			...sanitizeSessionSkillToolParts(activeMessages),
			preparedMessage.message,
		],
		newMessage: preparedMessage.message,
	};
};

/**
 * Prepares one submission: it joins any compaction in flight before it reads
 * the Session Context, resolves the attachment budget and Skill the Agent Turn
 * runs with, and materialises the user message it answers.
 */
const prepareSessionSubmission = async ({
	armSkill,
	deps,
	input,
	isContextContinuation,
	resolveSkill,
	signal,
}: {
	armSkill: (
		agentId: AgentId,
		signal: AbortSignal
	) => Promise<SessionSkillCatalog>;
	deps: SubmissionDeps;
	input: SessionSendInput;
	isContextContinuation: boolean;
	resolveSkill: AgentSessionPorts["skills"]["resolveSkill"];
	signal: AbortSignal;
}): Promise<SessionPreparationResult> => {
	const { ports } = deps;
	try {
		await ports.assertProviderModelSelection(input);
		// Settings and the attachment budget are resolved before anything joins a
		// compaction, so a compaction that starts while they resolve is joined by
		// the settle that follows rather than raced by this turn.
		const settings = await ports.resolveCompactionSettings(input.model);
		const attachmentBudget: SessionAttachmentBudget = {
			maxAttachments: settings.maxMediaAttachments,
			maxBytes: settings.maxMediaBytes,
			maxTokens: settings.maxMediaTokens,
		};
		const compactionError = await deps.settleCompaction();
		const compactionReason = isNull(compactionError)
			? null
			: compactionFailureReason(compactionError);
		if (!isNull(compactionReason)) {
			return { kind: "rejected", reason: compactionReason };
		}
		const compactionResult = await prepareCompactionBeforeSubmit({
			compaction: ports.compaction,
			getActiveMessages: deps.getContext,
			model: input.model,
			runCompaction: deps.compact,
			settings,
			settleCompaction: deps.settleCompaction,
			...omitUndefined({
				turnId: input.turnId,
				thinkingLevel: input.thinkingLevel,
			}),
		});
		if (!compactionResult.ok) {
			return { kind: "rejected", reason: compactionResult.reason };
		}
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		const context = await prepareSubmitContext({
			activeMessages: deps.getContext(),
			armSkill,
			input,
			isContextContinuation,
			resolveSkill,
			signal,
		});
		if (context.kind !== "ready") {
			return context;
		}
		const prepared = await prepareModelMessages({
			activeMessages: deps.getContext(),
			context,
			externalize: ports.attachments.externalize,
			input,
			resolveFileMentions: ports.resolveFileMentions,
			isContextContinuation,
			signal,
		});
		if (prepared.kind !== "ready") {
			return prepared;
		}
		return {
			attachmentBudget,
			context,
			kind: "ready",
			messages: prepared.messages,
			...omitUndefined({ newMessage: prepared.newMessage }),
		};
	} catch (error) {
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		const fields = getReportableSessionFailureFields(error);
		if (fields !== null) {
			void logger.error("Session submission preparation failed", {
				...fields,
				operation: "session.submission",
				phase: "preparation",
				...omitUndefined({ turnId: input.turnId }),
			});
		}
		const normalizedError = isError(error)
			? error
			: new Error("Session preparation failed.");
		return {
			error: normalizedError,
			kind: "rejected",
			reason: normalizedError.message,
		};
	}
};

export const sessionSendCancelled = (
	signal?: AbortSignal
): SessionSendOutcome => {
	if (isUndefined(signal)) {
		return { rejected: true, reason: "Session send cancelled." };
	}
	switch (getAgentTurnAbortDisposition(signal.reason)) {
		case "cancelled":
			return { rejected: true, reason: "Session send cancelled." };
		case "deadline-exceeded":
			return {
				rejected: true,
				reason: "Session send deadline exceeded.",
			};
		case "interrupted":
			return { rejected: true, reason: "Session turn interrupted." };
		default:
			return { rejected: true, reason: "Session send cancelled." };
	}
};

const sessionOutcomeForPreparation = (
	result: Extract<
		SubmitContextResult | PreparedModelMessages,
		{ kind: "cancelled" | "rejected" }
	>,
	signal: AbortSignal
): SessionSendOutcome =>
	result.kind === "cancelled"
		? sessionSendCancelled(signal)
		: { rejected: true, reason: result.reason };

/**
 * The Agent Turn execution a submission starts: the selection it runs with,
 * the session-level selection its records carry, and its source user message.
 */
const executionInputForSubmit = ({
	input,
	sourceUserMessageId,
	startedAt,
}: {
	input: SessionSendInput;
	sourceUserMessageId?: SessionMessageId;
	startedAt: number;
}): SessionExecutionInput => ({
	agent: input.agent,
	model: input.model,
	sessionModel: input.sessionModel,
	startedAt,
	...omitUndefined({
		sessionThinkingLevel: input.sessionThinkingLevel,
		sourceUserMessageId,
		submissionId: input.submissionId,
		turnId: input.turnId,
		thinkingLevel: input.thinkingLevel,
		maximumModelSteps: input.maximumModelSteps,
	}),
});

/**
 * Persists the accepted prompt as its own durable Session Record before the
 * Agent Turn runs, so a stored prompt always precedes its answer.
 */
const commitPromptRecord = async ({
	agent,
	message,
	model,
	sessionId,
	sessionModel,
	sessionThinkingLevel,
	thinkingLevel,
	commitRecord,
	diagnosticTurnId,
}: {
	agent: SessionSendInput["agent"];
	commitRecord: AgentSessionPorts["commitRecord"];
	diagnosticTurnId?: AgentTurnId;
	message: SessionMessage;
	model: SessionSendInput["model"];
	sessionId: SessionId;
	sessionModel: SessionSendInput["sessionModel"];
	sessionThinkingLevel?: ThinkingLevel;
	thinkingLevel?: ThinkingLevel;
}): Promise<Error | null> => {
	const recordTurnId = createAgentTurnId();
	try {
		await commitRecord({
			record: buildUserSessionRecord({
				agentId: agent,
				message,
				model,
				turnId: recordTurnId,
				thinkingLevel,
			}),
			sessionId,
			sessionModel,
			...omitUndefined({ sessionThinkingLevel }),
		});
		return null;
	} catch (error) {
		logSessionPersistenceFailure("Session prompt persistence failed", error, {
			operation: "session.prompt",
			phase: "persistence",
			turnId: diagnosticTurnId ?? recordTurnId,
		});
		return isError(error) ? error : new Error("Could not save the prompt.");
	}
};
const commitPreparedPrompt = async ({
	deps,
	input,
	message,
	signal,
}: {
	deps: SubmissionDeps;
	input: SessionSendInput;
	message: SessionMessage;
	signal: AbortSignal;
}): Promise<Error | null> => {
	assertSendNotCancelled(signal);
	const promptError = await commitPromptRecord({
		...omitUndefined({ diagnosticTurnId: input.turnId }),
		agent: input.agent,
		commitRecord: deps.ports.commitRecord,
		message,
		model: input.model,
		sessionId: deps.sessionId,
		sessionModel: input.sessionModel,
		...omitUndefined({
			sessionThinkingLevel: input.sessionThinkingLevel,
			thinkingLevel: input.thinkingLevel,
		}),
	});
	assertSessionOpen(deps);
	return promptError;
};

const applyPreparedMessages = (
	deps: SubmissionDeps,
	signal: AbortSignal,
	messages: readonly SessionMessage[],
	allowCancelled: boolean
): void => {
	if (!allowCancelled) {
		assertSendNotCancelled(signal);
	}
	assertSessionOpen(deps);
	deps.applyContext(messages);
	deps.mergeTranscript(messages);
	if (!allowCancelled) {
		assertSendNotCancelled(signal);
	}
	assertSessionOpen(deps);
};

/** Commits one Session Record for a live Session execution. */
const commitExecutionRecord = (
	deps: SubmissionDeps,
	execution: SessionExecution,
	record: SessionRecord
): Promise<void> =>
	deps.ports.commitRecord({
		sessionModel: execution.sessionModel,
		sessionThinkingLevel: execution.sessionThinkingLevel,
		record,
		sessionId: deps.sessionId,
	});

/**
 * Commits the record of an execution that ended without publishing a safe
 * assistant message of its own, then presents that message: the turn ends
 * visibly even when it never reached the model.
 */
const handleSafeAssistantOutcome = async ({
	commitRecord,
	currentMessages,
	deps,
	execution,
	record,
}: {
	commitRecord: (record: SessionRecord) => Promise<void>;
	currentMessages: readonly SessionMessage[];
	deps: SubmissionDeps;
	execution: SessionExecution;
	record: SessionRecord;
}): Promise<SessionSendOutcome> => {
	try {
		await commitRecord(record);
	} catch (commitError) {
		if (deps.isShutDown()) {
			return { rejected: false };
		}
		logSessionPersistenceFailure(
			"Agent turn outcome persistence failed",
			commitError,
			{
				operation: "session.turn",
				phase: "terminal-persistence",
				turnId: execution.turnId,
			}
		);
		const safeError = new Error(
			"The Agent Turn outcome could not be persisted.",
			{ cause: commitError }
		);
		deps.setError(safeError);
		return { rejected: true, reason: safeError.message };
	}
	if (deps.isShutDown()) {
		return { rejected: false };
	}
	const durableMessage = record.messages[0];
	const textPart = durableMessage?.parts.find((part) => part.type === "text");
	const terminal =
		record.outcome.kind === "assistant"
			? record.outcome.terminal.kind
			: "failed";
	const sourceUserMessageId = durableMessage?.metadata?.sourceUserMessageId;
	const failureMessage: SessionMessage = {
		id:
			durableMessage?.id ?? toSessionMessageId(`assistant-${execution.turnId}`),
		metadata: {
			agent: execution.agent,
			model: execution.model,
			...omitUndefined({
				sourceUserMessageId,
				thinkingLevel: execution.thinkingLevel,
			}),
			...(terminal === "interrupted" ? { interrupted: true } : {}),
			...(terminal === "completed" ? {} : { terminalOutcome: terminal }),
		},
		parts: [
			{
				text:
					textPart?.type === "text" ? textPart.text : "The Agent Turn failed.",
				type: "text",
			},
		],
		role: "assistant",
	};
	const nextMessages = [
		...currentMessages.filter(({ id }) => id !== failureMessage.id),
		failureMessage,
	];
	deps.applyContext(nextMessages);
	deps.mergeTranscript([failureMessage]);
	return { rejected: false };
};

/** The durable record inputs every terminal failure row of an execution shares. */
const failureRecordInput = (
	execution: SessionExecution,
	assistantMessageId: SessionMessageId
) => ({
	agentId: execution.agent,
	assistantMessageId,
	...omitUndefined({
		sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
		thinkingLevel: execution.thinkingLevel,
	}),
	model: execution.model,
	turnId: execution.turnId,
});

type OverflowRecoveryProposalInput = Readonly<{
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	deps: SubmissionDeps;
	execution: SessionExecution;
	failure?: unknown;
	trigger: SessionOverflowRecoveryCommand["trigger"];
}>;

const maintainAfterUnrecoveredOutputLimit = ({
	deps,
	execution,
	trigger,
}: OverflowRecoveryProposalInput): void => {
	if (trigger !== "output-limit" || deps.isShutDown()) {
		return;
	}
	maintainAfterTurn(
		deps,
		deps.getContext(),
		execution.model,
		execution.turnId,
		execution.thinkingLevel
	);
};

const getOverflowRecoveryFailureReason = (
	input: OverflowRecoveryProposalInput,
	outcome: SessionOverflowRecoveryOutcome
): string => {
	if (outcome.kind === "failed") {
		return outcome.error.message;
	}
	if (
		input.trigger === "context-overflow" &&
		isOperationalFailure(input.failure)
	) {
		return input.failure.message;
	}
	return getErrorMessage(
		input.failure,
		input.trigger === "output-limit"
			? "The Provider response stopped at its output-token limit."
			: "Context overflow recovery could not continue."
	);
};

const recoverAfterProviderStop = (
	input: OverflowRecoveryProposalInput,
	originalMessageId: SessionMessageId
): Promise<SessionOverflowRecoveryOutcome> => {
	const { context, deps, execution, failure, trigger } = input;
	const recoveryInput = {
		originalMessageId,
		continueContext: ({
			originalMessageId: contextMessageId,
		}: {
			originalMessageId: SessionMessageId;
		}) =>
			continueOverflowContext({
				context,
				deps,
				execution,
				originalMessageId: contextMessageId,
			}),
		resolveTarget: async () => {
			const settings = await deps.ports.resolveCompactionSettings(
				execution.model
			);
			if (!settings.overflowRecoveryAvailable) {
				return null;
			}
			return {
				model: execution.model,
				thinkingLevel: execution.thinkingLevel,
			};
		},
		turnId: execution.turnId,
	};
	return trigger === "context-overflow"
		? deps.recoverOverflow({ ...recoveryInput, error: failure, trigger })
		: deps.recoverOverflow({ ...recoveryInput, trigger });
};

const runOverflowRecoveryProposal = async (
	input: OverflowRecoveryProposalInput,
	originalMessageId: SessionMessageId
): Promise<void> => {
	const { deps, execution, trigger } = input;
	let outcome: SessionOverflowRecoveryOutcome;
	try {
		outcome = await recoverAfterProviderStop(input, originalMessageId);
	} catch (error) {
		await deps.acknowledgeSteeringMessages(
			execution.turnId,
			"failed",
			getErrorMessage(
				error,
				trigger === "output-limit"
					? "Output-limit recovery failed."
					: "Context overflow recovery failed."
			)
		);
		return;
	}
	if (outcome.kind !== "recovered") {
		await deps.acknowledgeSteeringMessages(
			execution.turnId,
			"failed",
			getOverflowRecoveryFailureReason(input, outcome)
		);
	}
	if (outcome.kind === "ineligible") {
		maintainAfterUnrecoveredOutputLimit(input);
	}
};

/** Proposes one safe compaction recovery for a context overflow or output-limit stop. */
const proposeOverflowRecovery = (
	input: OverflowRecoveryProposalInput
): void => {
	const { deps, execution, failure, trigger } = input;
	const originalMessageId = execution.sourceUserMessageId;
	if (isNull(originalMessageId)) {
		deps.trackBackgroundTask(
			deps.acknowledgeSteeringMessages(
				execution.turnId,
				"failed",
				getErrorMessage(
					failure,
					trigger === "output-limit"
						? "The Provider response stopped at its output-token limit."
						: "Context overflow recovery could not continue."
				)
			)
		);
		maintainAfterUnrecoveredOutputLimit(input);
		return;
	}
	deps.trackBackgroundTask(
		runOverflowRecoveryProposal(input, originalMessageId)
	);
};

/**
 * Starts a new Agent Turn from the existing Session Context after compaction.
 * The send lane refuses a continuation that would overlap work the session
 * already runs; recovery never queues behind or overlaps user-started work.
 */
const continueOverflowContext = async ({
	context,
	deps,
	execution,
	originalMessageId,
}: {
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	deps: SubmissionDeps;
	execution: SessionExecution;
	originalMessageId: SessionMessageId;
}): Promise<SessionOverflowContinuationOutcome> => {
	const previousError = deps.getError();
	const previousMessageIds = new Set(deps.getTranscript().map(({ id }) => id));
	let continuationStarted = false;
	let outcome: SessionSendOutcome;
	try {
		outcome = await deps.continueContext(
			{
				agent: execution.agent,
				messageId: originalMessageId,
				model: execution.model,
				resolvedAgent: context.resolvedAgent,
				sessionModel: execution.sessionModel,
				...omitUndefined({
					sessionThinkingLevel: execution.sessionThinkingLevel,
					thinkingLevel: execution.thinkingLevel,
				}),
			},
			() => {
				continuationStarted = true;
			}
		);
	} catch (error) {
		return continuationStarted
			? { kind: "failed" }
			: {
					kind: "refused",
					reason: getErrorMessage(error, "The continuation could not start."),
				};
	}
	const continuationError = deps.getError();
	if (!continuationStarted) {
		let reason: string;
		if (outcome.rejected) {
			reason = outcome.reason;
		} else if (
			continuationError !== null &&
			continuationError !== previousError
		) {
			reason = continuationError.message;
		} else {
			reason = "The continuation did not start.";
		}
		return { kind: "refused", reason };
	}
	const failedContinuation = deps
		.getTranscript()
		.some(
			({ id, metadata, role }) =>
				role === "assistant" &&
				!previousMessageIds.has(id) &&
				metadata?.sourceUserMessageId === originalMessageId &&
				metadata?.terminalOutcome !== undefined
		);
	if (
		(continuationError !== null &&
			(!outcome.rejected || continuationError !== previousError)) ||
		failedContinuation
	) {
		return { kind: "failed" };
	}
	return outcome.rejected
		? { kind: "refused", reason: outcome.reason }
		: { kind: "started" };
};

const handleRunTurnError = ({
	deps,
	error,
	executionStarted,
	onFailure,
	signal,
}: {
	deps: SubmissionDeps;
	error: unknown;
	executionStarted: boolean;
	onFailure: (error: unknown) => void;
	signal: AbortSignal;
}): SessionSendOutcome => {
	if (signal.aborted) {
		return executionStarted
			? { rejected: false }
			: sessionSendCancelled(signal);
	}
	const normalizedError = isError(error)
		? error
		: new Error("The Agent Turn failed.");
	deps.setError(normalizedError);
	if (!executionStarted) {
		return { rejected: true, reason: normalizedError.message };
	}
	onFailure(error);
	return { rejected: false };
};

/**
 * Ends an Agent Turn that failed. A turn that never started still commits its
 * safe terminal row, a turn that started but never reported a terminal event
 * synthesizes one from its abort or failure, and a failure the runtime already
 * reported is proposed for overflow recovery.
 */
const handleTurnFailure = async ({
	commitRecord,
	context,
	currentMessages,
	currentTurn,
	deps,
	error,
	execution,
	executionStarted,
	signal,
	terminalFailure,
	terminalObserved,
}: {
	commitRecord: (record: SessionRecord) => Promise<void>;
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	currentMessages: readonly SessionMessage[];
	currentTurn: AgentTurn | undefined;
	deps: SubmissionDeps;
	error: unknown;
	execution: SessionExecution;
	executionStarted: boolean;
	signal: AbortSignal;
	terminalFailure: OperationalFailure | undefined;
	terminalObserved: boolean;
}): Promise<SessionSendOutcome> => {
	const fields = errorLogFields(error);
	const errorCode = terminalFailure?.code ?? fields.errorCode;
	if (
		!signal.aborted &&
		getReportableSessionFailureFields(error, fields, errorCode) !== null
	) {
		void logger.error("Agent turn failed", {
			...fields,
			...(terminalFailure === undefined
				? {}
				: { errorCode: terminalFailure.code }),
			operation: "session.turn",
			phase: executionStarted ? "execution" : "preparation",
			turnId: execution.turnId,
		});
	}
	if (!executionStarted) {
		if (signal.aborted) {
			return handleSafeAssistantOutcome({
				commitRecord,
				currentMessages,
				deps,
				execution,
				record: buildAssistantCancelledSessionRecord(
					failureRecordInput(
						execution,
						deps.getAssistantMessageId(execution.turnId)
					)
				),
			});
		}
		return handleSafeAssistantOutcome({
			commitRecord,
			currentMessages,
			deps,
			execution,
			record: buildAssistantFailureSessionRecord({
				...failureRecordInput(
					execution,
					deps.getAssistantMessageId(execution.turnId)
				),
				error,
			}),
		});
	}
	if (!(terminalObserved || isUndefined(currentTurn))) {
		const fallbackRecord = signal.aborted
			? buildTerminalSessionRecord({
					assistantMessageId: deps.getAssistantMessageId(execution.turnId),
					assistantText: "",
					event: createAgentTurnAbortEvent(currentTurn, signal, 0),
					...omitUndefined({
						sourceUserMessageId: execution.sourceUserMessageId ?? undefined,
					}),
					turn: currentTurn,
				})
			: buildAssistantFailureSessionRecord({
					...failureRecordInput(
						execution,
						deps.getAssistantMessageId(execution.turnId)
					),
					error,
				});
		if (!isUndefined(fallbackRecord)) {
			return handleSafeAssistantOutcome({
				commitRecord,
				currentMessages,
				deps,
				execution,
				record: fallbackRecord,
			});
		}
	}
	if (signal.aborted) {
		return { rejected: false };
	}
	return handleRunTurnError({
		deps,
		error,
		executionStarted,
		onFailure: (failure) =>
			proposeOverflowRecovery({
				context,
				deps,
				execution,
				failure: terminalFailure ?? failure,
				trigger: "context-overflow",
			}),
		signal,
	});
};

const logThresholdSettingsFailure = (
	error: unknown,
	turnId: AgentTurnId
): void => {
	const fields = getReportableSessionFailureFields(error);
	if (fields === null) {
		return;
	}
	void logger.warn("Automatic compaction threshold check failed", {
		...fields,
		operation: "session.compaction",
		phase: "check",
		trigger: "threshold",
		turnId,
	});
};
/**
 * Maintains the session's compaction threshold after a completed turn. A
 * compaction another caller owns is left to that caller: the next submission
 * re-checks the threshold and compacts then.
 */
const maintainAfterTurn = (
	deps: SubmissionDeps,
	messages: readonly SessionMessage[],
	selection: SessionExecution["model"],
	turnId: AgentTurnId,
	thinkingLevel?: ThinkingLevel
): void => {
	const compactIfNeeded = async (): Promise<void> => {
		let settings: ResolvedCompactionSettings;
		try {
			settings = await deps.ports.resolveCompactionSettings(selection);
			if (
				!needsThresholdCompaction(
					deps.ports.compaction,
					deps.getContext(),
					settings,
					selection
				)
			) {
				return;
			}
		} catch (error) {
			logThresholdSettingsFailure(error, turnId);
			return;
		}
		try {
			await deps.compact({
				model: selection,
				nextMessages: messages,
				trigger: "threshold",
				turnId,
				...omitUndefined({ thinkingLevel }),
			});
		} catch (error) {
			if (isBenignCompactionError(error) || isInFlightCompaction(error)) {
				return;
			}
			deps.setCompactionError(
				isError(error) ? error : new Error("Automatic compaction failed.")
			);
		}
	};
	deps.trackBackgroundTask(compactIfNeeded());
};

/** Runs one Agent Turn execution and turns its outcome into session state. */
const runTurn = async ({
	attachmentBudget,
	context,
	deps,
	execution,
	modelMessages,
	onExecutionStarted,
	onTurnFailure,
	signal,
}: {
	attachmentBudget: SessionAttachmentBudget;
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	deps: SubmissionDeps;
	execution: SessionExecution;
	modelMessages: readonly SessionMessage[];
	onExecutionStarted?: () => void;
	onTurnFailure: () => void;
	signal: AbortSignal;
}): Promise<SessionSendOutcome> => {
	let contextEpoch = getSessionContextEpoch(modelMessages);
	let lastModelStepInputTokens: number | null = null;
	let executionActive = true;
	let terminalCommitted = false;
	const turnIsLive = (): boolean =>
		executionActive && !deps.isShutDown() && !signal.aborted;
	const commitRecord = async (record: SessionRecord): Promise<void> => {
		if (!turnIsLive()) {
			return;
		}
		await commitExecutionRecord(deps, execution, record);
	};
	const commitTerminal = async (record: SessionRecord): Promise<void> => {
		if (!executionActive || deps.isShutDown()) {
			return;
		}
		await commitExecutionRecord(deps, execution, record);
		terminalCommitted = true;
	};
	let executionStarted = false;
	const markExecutionStarted = (): void => {
		if (executionStarted) {
			return;
		}
		executionStarted = true;
		onExecutionStarted?.();
	};
	let terminalObserved = false;
	let terminalOutputLimitReached = false;
	let terminalFailure: OperationalFailure | undefined;
	const callbacks: SessionTurnCallbacks = {
		commitStep: async (record) => {
			if (!turnIsLive()) {
				throw new SessionSendCancelledError();
			}
			if (record !== undefined) {
				await commitRecord(record);
			}
			// A completed durable write wins cancellation: seal its identity before terminal persistence.
			deps.finishModelStep(execution.turnId, record);
			if (!turnIsLive()) {
				throw new SessionSendCancelledError();
			}
		},
		commitTerminal,
		commitToolCall: commitRecord,
		onEvent: async (event) => {
			if (!turnIsLive()) {
				return;
			}
			markExecutionStarted();
			if (event.type === "model-step-finished") {
				lastModelStepInputTokens = event.usage?.inputTokens ?? null;
				await deps.acknowledgeSteeringMessages(execution.turnId, "processed");
			}
			const currentExecution = {
				...execution,
				assistantId: deps.getAssistantMessageId(execution.turnId),
			};
			const projected = projectAgentTurnEvent(
				deps.getContext(),
				currentExecution,
				event,
				contextEpoch
			);
			if (isUndefined(projected)) {
				return;
			}
			deps.applyContext(projected.messages);
			deps.mergeTranscript([projected.message]);
		},
		onTerminal: async (event) => {
			// Only a committed terminal outcome may reconcile after cancellation; late Provider callbacks cannot.
			if (
				!executionActive ||
				deps.isShutDown() ||
				(signal.aborted && !terminalCommitted)
			) {
				return;
			}
			markExecutionStarted();
			terminalObserved = true;
			terminalOutputLimitReached =
				event.type === "agent-turn-completed" &&
				event.outputLimitReached === true;
			const failed = event.type !== "agent-turn-completed";
			const deferSteeringFailure =
				event.type === "agent-turn-failed" &&
				isContextOverflowFailure(event.failure);
			let steeringFailure: string | undefined;
			if (event.type === "agent-turn-failed") {
				steeringFailure = event.failure.message;
			} else if (failed) {
				steeringFailure =
					"The Agent Turn ended before confirming the Steering Message.";
			}
			if (!deferSteeringFailure) {
				await deps.acknowledgeSteeringMessages(
					execution.turnId,
					failed ? "failed" : "processed",
					steeringFailure
				);
			}
			terminalFailure =
				event.type === "agent-turn-failed" ? event.failure : undefined;
			const currentExecution = {
				...execution,
				assistantId: deps.getAssistantMessageId(execution.turnId),
			};
			const messages = projectAgentTurnTerminal(
				deps.getContext(),
				currentExecution,
				event
			);
			deps.applyContext(messages);
			deps.mergeTranscript(messages);
		},
		onViewState: (viewState) => {
			if (!turnIsLive()) {
				return;
			}
			deps.setExecutionViewState(execution.turnId, viewState);
		},
	};
	try {
		void logger.debug("Agent turn started", {
			operation: "session.turn",
			phase: "started",
			turnId: execution.turnId,
		});
		assertSessionOpen(deps);
		deps.setError(null);
		const hydrated = await deps.ports.attachments.hydrate({
			budget: attachmentBudget,
			failOnMissingAttachments:
				context.anchoredMessage?.metadata?.submissionStatus === "processing",
			messages: modelMessages,
			priorityMessageId: modelMessages.findLast(({ role }) => role === "user")
				?.id,
			signal,
		});
		assertSessionOpen(deps);
		if (!turnIsLive()) {
			return { rejected: false };
		}
		const outcome = await deps.ports.turnRunner.run({
			armedSkill: context.armedSkill,
			callbacks,
			execution,
			getAssistantMessageId: () => deps.getAssistantMessageId(execution.turnId),
			prepareNextStep: async ({ protectedMessageIds }) => {
				assertSendNotCancelled(signal);
				const pendingFailure = await deps.settleCompaction();
				if (pendingFailure !== null) {
					throw pendingFailure;
				}
				const settings = await deps.ports.resolveCompactionSettings(
					execution.model
				);
				const trigger = getContextCompactionTrigger(
					deps.ports.compaction,
					deps.getContext(),
					settings,
					execution.model,
					lastModelStepInputTokens
				);
				if (trigger === null) {
					return;
				}
				const activeIds = new Set(
					deps.getContext().map((message) => message.id)
				);
				const transcript = deps.getTranscript();
				const durableIds = new Set(transcript.map((message) => message.id));
				const protectedIds = protectedMessageIds.filter((id) =>
					durableIds.has(id)
				);
				if (
					protectedIds.length === 0 ||
					protectedIds.some((id) => !activeIds.has(id))
				) {
					throw new Error(
						"The current durable continuation checkpoint is missing from active context."
					);
				}
				const sourceMessages = transcript.filter(
					(message) =>
						message.metadata?.joinedTurnId === undefined ||
						activeIds.has(message.id)
				);
				try {
					const result = await deps.compact({
						model: execution.model,
						sourceMessages,
						protectedMessageIds: protectedIds,
						signal,
						trigger,
						turnId: execution.turnId,
						...omitUndefined({ thinkingLevel: execution.thinkingLevel }),
					});
					if (trigger === "overflow") {
						lastModelStepInputTokens = null;
					}
					assertSendNotCancelled(signal);
					const protectedSet = new Set(protectedIds);
					const index = result.activeMessages.findIndex((message) =>
						protectedSet.has(message.id)
					);
					if (index < 0) {
						throw new Error(
							"Compaction lost the protected continuation checkpoint."
						);
					}
					contextEpoch = getSessionContextEpoch(result.activeMessages);
					return deps.ports.attachments.hydrate({
						budget: attachmentBudget,
						messages: result.activeMessages.slice(0, index),
						signal,
					});
				} catch (error) {
					deps.setCompactionError(
						isError(error)
							? error
							: new Error("Between-step compaction failed.")
					);
					throw error;
				}
			},
			messages: hydrated,
			resolvedAgent: context.resolvedAgent,
			...omitUndefined({ skillRequest: context.skill }),
			signal,
			takeSteeringMessages: async () =>
				turnIsLive()
					? deps.takeSteeringMessages(execution, context.armedSkill, signal)
					: [],
		});
		if (!turnIsLive()) {
			await deps.acknowledgeSteeringMessages(execution.turnId, "failed");
			return { rejected: false };
		}
		if (isUndefined(outcome.error)) {
			void logger.debug("Agent turn completed", {
				operation: "session.turn",
				phase: "completed",
				turnId: execution.turnId,
			});
			if (terminalOutputLimitReached) {
				proposeOverflowRecovery({
					context,
					deps,
					execution,
					trigger: "output-limit",
				});
			} else {
				maintainAfterTurn(
					deps,
					deps.getContext(),
					execution.model,
					execution.turnId,
					execution.thinkingLevel
				);
			}
			return { rejected: false };
		}
		onTurnFailure();
		if (
			!(terminalObserved || (executionStarted && isUndefined(outcome.turn)))
		) {
			await deps.acknowledgeSteeringMessages(
				execution.turnId,
				"failed",
				getErrorMessage(
					outcome.error,
					"The Agent Turn ended before confirming the Steering Message."
				)
			);
		}
		return handleTurnFailure({
			commitRecord,
			context,
			currentMessages: deps.getContext(),
			currentTurn: outcome.turn,
			deps,
			error: outcome.error,
			execution,
			executionStarted,
			signal,
			terminalFailure,
			terminalObserved,
		});
	} catch (error) {
		if (!executionActive) {
			return { rejected: false };
		}
		await deps.acknowledgeSteeringMessages(
			execution.turnId,
			"failed",
			getErrorMessage(
				error,
				"The Agent Turn ended before confirming the Steering Message."
			)
		);
		if (deps.isShutDown() || signal.aborted) {
			return { rejected: false };
		}
		onTurnFailure();
		return handleTurnFailure({
			commitRecord,
			context,
			currentMessages: deps.getContext(),
			currentTurn: undefined,
			deps,
			error,
			execution,
			executionStarted,
			signal,
			terminalFailure,
			terminalObserved,
		});
	} finally {
		executionActive = false;
		deps.endExecution(execution.turnId);
	}
};

export type SubmissionPipeline = Readonly<{
	send: (
		input: SessionSendInput,
		signal: AbortSignal,
		onExecutionStarted?: () => void
	) => Promise<SessionSendOutcome>;
}>;

/**
 * The Agent Session's Submission Command: it prepares the submission, commits
 * the accepted user message, runs the Agent Turn against the Host runtime,
 * commits each Steering Message that turn takes at a Model Step boundary, and
 * maintains the compaction threshold afterwards. Every state write is ordered
 * by this command, so observers only ever read settled session state.
 */
export const createSubmissionPipeline = (
	deps: SubmissionDeps
): SubmissionPipeline => {
	const armSkill = async (
		agentId: AgentId,
		signal: AbortSignal
	): Promise<SessionSkillCatalog> => {
		const catalog = await deps.ports.skills.createTurnSkill(agentId);
		if (signal.aborted || deps.isShutDown()) {
			return catalog;
		}
		deps.setCatalogDiagnostic(catalog.diagnostic);
		return catalog;
	};
	const send = async (
		input: SessionSendInput,
		signal: AbortSignal,
		onExecutionStarted?: () => void
		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each cancellation checkpoint fences one awaited state mutation.
	): Promise<SessionSendOutcome> => {
		if (deps.isShutDown() || signal.aborted) {
			return signal.aborted
				? sessionSendCancelled(signal)
				: { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
		}
		deps.setCompactionError(null);
		let failedTurnId: AgentTurnId | undefined;
		deps.setRunPhase("preparing");
		try {
			const startedAt = Date.now();
			const isContextContinuation = deps.isContextContinuation(input);
			const resolvedInput = deps.ports.resolveSubmission(input);
			const prepared = await prepareSessionSubmission({
				armSkill,
				deps,
				input: resolvedInput,
				isContextContinuation,
				resolveSkill: deps.ports.skills.resolveSkill,
				signal,
			});
			assertSendNotCancelled(signal);
			assertSessionOpen(deps);
			if (prepared.kind !== "ready") {
				if (prepared.kind === "rejected" && !isUndefined(prepared.error)) {
					deps.setError(prepared.error);
				}
				return sessionOutcomeForPreparation(prepared, signal);
			}
			const { attachmentBudget, context, messages: modelMessages } = prepared;
			const hasCommittedPrompt = !isUndefined(prepared.newMessage);
			if (hasCommittedPrompt) {
				const promptError = await commitPreparedPrompt({
					deps,
					input: resolvedInput,
					message: prepared.newMessage,
					signal,
				});
				if (!isNull(promptError)) {
					deps.setError(promptError);
					return { rejected: true, reason: "Could not save the prompt." };
				}
			}
			applyPreparedMessages(deps, signal, modelMessages, hasCommittedPrompt);
			if (signal.aborted) {
				return sessionSendCancelled(signal);
			}
			const execution = deps.beginExecution(
				executionInputForSubmit({
					input: resolvedInput,
					sourceUserMessageId:
						context.anchoredMessage?.id ??
						(isContextContinuation ? resolvedInput.messageId : undefined) ??
						prepared.newMessage?.id,
					startedAt,
				})
			);
			deps.setRunPhase("running");
			return await runTurn({
				attachmentBudget,
				context,
				deps,
				execution,
				modelMessages,
				onExecutionStarted,
				onTurnFailure: () => {
					failedTurnId = execution.turnId;
				},
				signal,
			});
		} catch (error) {
			if (error instanceof SessionSendCancelledError) {
				return sessionSendCancelled(signal);
			}
			if (error instanceof SessionClosedError) {
				return { rejected: true, reason: SESSION_SHUT_DOWN_ERROR };
			}
			throw error;
		} finally {
			if (failedTurnId !== undefined) {
				deps.recallFailedTurnMessages(failedTurnId);
			}
			deps.setRunPhase("settling");
		}
	};
	return { send };
};

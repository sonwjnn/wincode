import {
	type AgentTurn,
	type AgentTurnId,
	createAgentTurnAbortEvent,
	createAgentTurnId,
	getAgentTurnAbortDisposition,
	type OperationalFailure,
	type SessionMessageId,
	type SessionRecord,
	toSessionMessageId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import {
	getErrorMessage,
	isError,
	isNull,
	isUndefined,
} from "@wincode/runtime-utils";
import { createSkillSnapshot, type SkillRequestContext } from "@wincode/skills";
import type { SessionId } from "@/shared/identifiers";
import type { CompactSessionResult } from "../compaction/compaction";
import type { ResolvedCompactionSettings } from "../compaction/config";
import { SessionCompactionError } from "../compaction/error";
import type { SessionViewState } from "../hooks/runtime-turn";
import {
	createSessionUserMessage,
	type SessionMessage,
	type SessionMessageMetadata,
	sanitizeSessionSkillToolParts,
} from "../message";
import type {
	SessionSendInput,
	SessionSendOutcome,
} from "../session-operation";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "../session-retry";
import { buildUserSessionRecord } from "../storage/session-record";
import {
	buildAssistantCancelledSessionRecord,
	buildAssistantFailureSessionRecord,
	buildTerminalSessionRecord,
} from "../turn-records";
import { projectAgentTurnEvent, projectAgentTurnTerminal } from "./turn";
import type {
	SessionAttachmentBudget,
	SessionCompactionCommand,
	SessionEnginePorts,
	SessionExecution,
	SessionExecutionInput,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionOverflowReplayOutcome,
	SessionSkillCatalog,
	SessionTurnCallbacks,
} from "./types";

/** The Session Engine state and commands one submission runs against. */
export type SubmissionDeps = Readonly<{
	applyContext: (messages: readonly SessionMessage[]) => void;
	beginExecution: (input: SessionExecutionInput) => SessionExecution;
	compact: (command: SessionCompactionCommand) => Promise<CompactSessionResult>;
	endExecution: (turnId: AgentTurnId) => void;
	getContext: () => readonly SessionMessage[];
	getTranscript: () => readonly SessionMessage[];
	mergeTranscript: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
	ports: SessionEnginePorts;
	recoverOverflow: (
		command: SessionOverflowRecoveryCommand
	) => Promise<SessionOverflowRecoveryOutcome>;
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	sessionId: SessionId;
	setCatalogDiagnostic: (diagnostic: string | null) => void;
	setCompactionError: (error: Error | null) => void;
	setError: (error: Error | null) => void;
	setExecutionViewState: (
		turnId: AgentTurnId,
		viewState: SessionViewState
	) => void;
	setTurnActive: (value: boolean) => void;
	settleCompaction: () => Promise<Error | null>;
}>;

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
	compaction: SessionEnginePorts["compaction"],
	messages: readonly SessionMessage[],
	settings: ResolvedCompactionSettings
): boolean =>
	settings.autoAvailable && compaction.needsCompaction(messages, settings);

export const prepareCompactionBeforeSubmit = async ({
	compaction,
	getActiveMessages,
	model,
	runCompaction,
	settings,
	settleCompaction,
	variant,
}: {
	compaction: SessionEnginePorts["compaction"];
	getActiveMessages: () => readonly SessionMessage[];
	model: ChatModelSelection;
	runCompaction: (
		command: SessionCompactionCommand
	) => Promise<CompactSessionResult>;
	settings: ResolvedCompactionSettings;
	settleCompaction: () => Promise<Error | null>;
	variant?: ModelVariant;
}): Promise<SubmitCompactionResult> => {
	// The threshold this Agent Turn needs has to hold on the Session Context it
	// sends, so a compaction another caller owns is joined and the need
	// re-checked against the settled context rather than raced.
	while (true) {
		if (!needsThresholdCompaction(compaction, getActiveMessages(), settings)) {
			return { ok: true };
		}
		try {
			await runCompaction({
				model,
				trigger: "threshold",
				...(isUndefined(variant) ? {} : { variant }),
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
	...(isUndefined(input.variant) ? {} : { variant: input.variant }),
	...(isUndefined(skill)
		? {}
		: { skill: createSkillSnapshot(skill, "explicit") }),
});

const prepareSubmitContext = async ({
	activeMessages,
	armSkill,
	input,
	resolveSkill,
	signal,
}: {
	activeMessages: readonly SessionMessage[];
	armSkill: () => Promise<SessionSkillCatalog>;
	input: SessionSendInput;
	resolveSkill: SessionEnginePorts["skills"]["resolveSkill"];
	signal: AbortSignal;
}): Promise<SubmitContextResult> => {
	const armedSkill = await armSkill();
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
	if (!isUndefined(input.messageId) && anchoredMessage?.role !== "user") {
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
	externalize: SessionEnginePorts["attachments"]["externalize"];
	input: SessionSendInput;
	metadata: SessionMessageMetadata;
	resolveFileMentions: SessionEnginePorts["resolveFileMentions"];
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
		input.files ?? []
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
	resolveFileMentions,
	signal,
}: {
	activeMessages: readonly SessionMessage[];
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	externalize: SessionEnginePorts["attachments"]["externalize"];
	input: SessionSendInput;
	resolveFileMentions: SessionEnginePorts["resolveFileMentions"];
	signal: AbortSignal;
}): Promise<PreparedModelMessages> => {
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
	resolveSkill,
	signal,
}: {
	armSkill: () => Promise<SessionSkillCatalog>;
	deps: SubmissionDeps;
	input: SessionSendInput;
	resolveSkill: SessionEnginePorts["skills"]["resolveSkill"];
	signal: AbortSignal;
}): Promise<SessionPreparationResult> => {
	const { ports } = deps;
	try {
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
			...(isUndefined(input.variant) ? {} : { variant: input.variant }),
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
			...(isUndefined(prepared.newMessage)
				? {}
				: { newMessage: prepared.newMessage }),
		};
	} catch (error) {
		if (signal.aborted) {
			return { kind: "cancelled" };
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
	...(isUndefined(input.delegation) ? {} : { parent: input.delegation }),
	...(isUndefined(input.sessionVariant)
		? {}
		: { sessionVariant: input.sessionVariant }),
	...(isUndefined(sourceUserMessageId) ? {} : { sourceUserMessageId }),
	...(isUndefined(input.variant) ? {} : { variant: input.variant }),
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
	sessionVariant,
	variant,
	commitRecord,
}: {
	agent: SessionSendInput["agent"];
	commitRecord: SessionEnginePorts["commitRecord"];
	message: SessionMessage;
	model: ChatModelSelection;
	sessionId: SessionId;
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	variant?: ModelVariant;
}): Promise<Error | null> => {
	try {
		await commitRecord({
			record: buildUserSessionRecord({
				agentId: agent,
				message,
				model,
				turnId: createAgentTurnId(),
				variant,
			}),
			sessionId,
			sessionModel,
			...(isUndefined(sessionVariant) ? {} : { sessionVariant }),
		});
		return null;
	} catch (error) {
		return isError(error) ? error : new Error("Could not save the prompt.");
	}
};

/**
 * Commits one Session Record of an execution: a delegated execution's records
 * carry no session-level selection, because the Subagent runs its own.
 */
const commitExecutionRecord = (
	deps: SubmissionDeps,
	execution: SessionExecution,
	record: SessionRecord
): Promise<void> =>
	deps.ports.commitRecord({
		...(isUndefined(execution.parent)
			? {
					sessionModel: execution.sessionModel,
					sessionVariant: execution.sessionVariant,
				}
			: {}),
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
		const safeError = new Error(
			"The Agent Turn outcome could not be persisted.",
			{ cause: commitError }
		);
		deps.setError(safeError);
		return { rejected: true, reason: safeError.message };
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
			...(isUndefined(sourceUserMessageId) ? {} : { sourceUserMessageId }),
			...(terminal === "interrupted" ? { interrupted: true } : {}),
			...(terminal === "completed" ? {} : { terminalOutcome: terminal }),
			...(isUndefined(execution.variant) ? {} : { variant: execution.variant }),
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
const failureRecordInput = (execution: SessionExecution) => ({
	agentId: execution.agent,
	...(isUndefined(execution.parent) ? {} : { delegation: execution.parent }),
	model: execution.model,
	turnId: execution.turnId,
	...(isUndefined(execution.variant) ? {} : { variant: execution.variant }),
	...(isNull(execution.sourceUserMessageId)
		? {}
		: { sourceUserMessageId: execution.sourceUserMessageId }),
});

/**
 * Proposes the one overflow recovery the Engine may run for the Agent Turn a
 * provider refused. The Engine owns the attempt and the classification, so
 * this only supplies what a recovery needs: where to compact against, and how
 * to replay the original user message.
 */
const proposeOverflowRecovery = ({
	context,
	deps,
	execution,
	failure,
}: {
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	deps: SubmissionDeps;
	execution: SessionExecution;
	failure: unknown;
}): void => {
	const originalMessageId = execution.sourceUserMessageId;
	if (isNull(originalMessageId)) {
		return;
	}
	void deps.recoverOverflow({
		error: failure,
		originalMessageId,
		replay: ({ originalMessageId: replayId }) =>
			replayOverflowTurn({
				context,
				deps,
				execution,
				originalMessageId: replayId,
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
				...(isUndefined(execution.variant)
					? {}
					: { variant: execution.variant }),
			};
		},
		turnId: execution.turnId,
	});
};

/**
 * Replays the original user message as the Agent Turn the recovery continues.
 * The send lane refuses a replay that would overlap a send the session already
 * runs, and that refusal is the replay's outcome: a recovery never queues
 * behind, or overlaps, work the user started.
 */
const replayOverflowTurn = async ({
	context,
	deps,
	execution,
	originalMessageId,
}: {
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	deps: SubmissionDeps;
	execution: SessionExecution;
	originalMessageId: SessionMessageId;
}): Promise<SessionOverflowReplayOutcome> => {
	const outcome = await deps.send({
		agent: execution.agent,
		messageId: originalMessageId,
		model: execution.model,
		resolvedAgent: context.resolvedAgent,
		sessionModel: execution.sessionModel,
		...(isUndefined(execution.sessionVariant)
			? {}
			: { sessionVariant: execution.sessionVariant }),
		...(isUndefined(execution.variant) ? {} : { variant: execution.variant }),
	});
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
	if (!executionStarted) {
		if (signal.aborted) {
			return handleSafeAssistantOutcome({
				commitRecord,
				currentMessages,
				deps,
				execution,
				record: buildAssistantCancelledSessionRecord(
					failureRecordInput(execution)
				),
			});
		}
		return handleSafeAssistantOutcome({
			commitRecord,
			currentMessages,
			deps,
			execution,
			record: buildAssistantFailureSessionRecord({
				...failureRecordInput(execution),
				error,
			}),
		});
	}
	if (!(terminalObserved || isUndefined(currentTurn))) {
		const fallbackRecord = signal.aborted
			? buildTerminalSessionRecord({
					assistantText: "",
					event: createAgentTurnAbortEvent(currentTurn, signal, 0),
					...(isNull(execution.sourceUserMessageId)
						? {}
						: { sourceUserMessageId: execution.sourceUserMessageId }),
					turn: currentTurn,
				})
			: buildAssistantFailureSessionRecord({
					...failureRecordInput(execution),
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
			}),
		signal,
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
	selection: ChatModelSelection,
	variant?: ModelVariant
): void => {
	const compactIfNeeded = async (): Promise<void> => {
		const settings = await deps.ports.resolveCompactionSettings(selection);
		if (!needsThresholdCompaction(deps.ports.compaction, messages, settings)) {
			return;
		}
		try {
			await deps.compact({
				model: selection,
				nextMessages: messages,
				trigger: "threshold",
				...(isUndefined(variant) ? {} : { variant }),
			});
		} catch (error) {
			if (!(isBenignCompactionError(error) || isInFlightCompaction(error))) {
				deps.setCompactionError(
					isError(error) ? error : new Error("Automatic compaction failed.")
				);
			}
		}
	};
	void compactIfNeeded();
};

/** Runs one Agent Turn execution and turns its outcome into session state. */
const runTurn = async ({
	attachmentBudget,
	context,
	deps,
	execution,
	modelMessages,
	signal,
}: {
	attachmentBudget: SessionAttachmentBudget;
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	deps: SubmissionDeps;
	execution: SessionExecution;
	modelMessages: readonly SessionMessage[];
	signal: AbortSignal;
}): Promise<SessionSendOutcome> => {
	deps.setError(null);
	const commitRecord = (record: SessionRecord) =>
		commitExecutionRecord(deps, execution, record);
	let executionStarted = false;
	let terminalObserved = false;
	let terminalFailure: OperationalFailure | undefined;
	const callbacks: SessionTurnCallbacks = {
		commitTerminal: commitRecord,
		commitToolCall: commitRecord,
		onEvent: (event) => {
			executionStarted = true;
			const projected = projectAgentTurnEvent(
				deps.getContext(),
				execution,
				event
			);
			if (isUndefined(projected)) {
				return;
			}
			deps.applyContext(projected.messages);
			deps.mergeTranscript([projected.message]);
		},
		onTerminal: (event) => {
			executionStarted = true;
			terminalObserved = true;
			terminalFailure =
				event.type === "agent-turn-failed" ? event.failure : undefined;
			const messages = projectAgentTurnTerminal(
				deps.getContext(),
				execution,
				event
			);
			deps.applyContext(messages);
			deps.mergeTranscript(messages);
		},
		onViewState: (viewState) =>
			deps.setExecutionViewState(execution.turnId, viewState),
	};
	try {
		const hydrated = await deps.ports.attachments.hydrate({
			budget: attachmentBudget,
			messages: modelMessages,
			priorityMessageId: modelMessages.findLast(({ role }) => role === "user")
				?.id,
			signal,
		});
		const outcome = await deps.ports.runtime.run({
			armedSkill: context.armedSkill,
			callbacks,
			execution,
			messages: hydrated,
			resolvedAgent: context.resolvedAgent,
			...(isUndefined(context.skill) ? {} : { skillRequest: context.skill }),
			signal,
		});
		if (isUndefined(outcome.error)) {
			maintainAfterTurn(
				deps,
				deps.getTranscript(),
				execution.model,
				execution.variant
			);
			return { rejected: false };
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
		deps.endExecution(execution.turnId);
	}
};

export type SubmissionPipeline = Readonly<{
	send: (
		input: SessionSendInput,
		signal: AbortSignal
	) => Promise<SessionSendOutcome>;
}>;

/**
 * The Engine's Submission Command: it prepares the submission, commits the
 * accepted user message, runs the Agent Turn against the host's runtime, and
 * maintains the compaction threshold afterwards. Every state write happens
 * here, in submission order, so an observer only ever reads a settled session.
 */
export const createSubmissionPipeline = (
	deps: SubmissionDeps
): SubmissionPipeline => {
	const armSkill = async (): Promise<SessionSkillCatalog> => {
		const catalog = await deps.ports.skills.createTurnSkill();
		deps.setCatalogDiagnostic(catalog.diagnostic);
		return catalog;
	};
	const send = async (
		input: SessionSendInput,
		signal: AbortSignal
	): Promise<SessionSendOutcome> => {
		deps.setCompactionError(null);
		deps.setTurnActive(true);
		try {
			const startedAt = Date.now();
			const prepared = await prepareSessionSubmission({
				armSkill,
				deps,
				input,
				resolveSkill: deps.ports.skills.resolveSkill,
				signal,
			});
			if (prepared.kind !== "ready") {
				if (prepared.kind === "rejected" && !isUndefined(prepared.error)) {
					deps.setError(prepared.error);
				}
				return sessionOutcomeForPreparation(prepared, signal);
			}
			const { attachmentBudget, context, messages: modelMessages } = prepared;
			if (!isUndefined(prepared.newMessage)) {
				const promptError = await commitPromptRecord({
					agent: input.agent,
					commitRecord: deps.ports.commitRecord,
					message: prepared.newMessage,
					model: input.model,
					sessionId: deps.sessionId,
					sessionModel: input.sessionModel,
					...(isUndefined(input.sessionVariant)
						? {}
						: { sessionVariant: input.sessionVariant }),
					...(isUndefined(input.variant) ? {} : { variant: input.variant }),
				});
				if (!isNull(promptError)) {
					deps.setError(promptError);
					return { rejected: true, reason: "Could not save the prompt." };
				}
			}
			deps.applyContext(modelMessages);
			deps.mergeTranscript(modelMessages);
			const execution = deps.beginExecution(
				executionInputForSubmit({
					input,
					sourceUserMessageId:
						context.anchoredMessage?.id ?? prepared.newMessage?.id,
					startedAt,
				})
			);
			return await runTurn({
				attachmentBudget,
				context,
				deps,
				execution,
				modelMessages,
				signal,
			});
		} finally {
			deps.setTurnActive(false);
		}
	};
	return { send };
};

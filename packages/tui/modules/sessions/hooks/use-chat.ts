import {
	type AgentId,
	type AgentTurn,
	type AgentTurnDelegation,
	type AgentTurnEvent,
	type AgentTurnId,
	type AgentTurnTerminalEvent,
	createAgentTurnAbortEvent,
	createAgentTurnId,
	getAgentTurnAbortDisposition,
	type SessionMessageId,
	type SessionRecord,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import { type ModelUsage, normalizeModelUsage } from "@wincode/ai/model-usage";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { defaultChatModelSelection } from "@wincode/ai/models";
import {
	type CodingToolName,
	codingToolDefinitions,
	codingToolNames,
} from "@wincode/coding-tools";
import {
	getErrorMessage,
	isError,
	isNull,
	isUndefined,
} from "@wincode/runtime-utils";
import {
	buildSkillToolDefinition,
	createSkillExecution,
	createSkillSnapshot,
	isSkillToolPart,
	type SkillCatalog,
	type SkillContext,
	type SkillExecution,
	type SkillRequestContext,
} from "@wincode/skills";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentRegistry } from "@/modules/agents";
import { useConnections } from "@/modules/connections";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import { createMcpToolExecutor, useMcp } from "@/modules/mcp";
import { useToolPermission } from "@/modules/permissions";
import { prepareAgentTurnPrompt } from "@/modules/prompt-composition/composer";
import { MAX_PROJECT_INSTRUCTION_TOTAL_BYTES } from "@/modules/prompt-composition/project-instructions";
import {
	COMPACTION_REQUEST_OVERHEAD_TOKENS,
	type CompactSessionInput,
	type CompactSessionResult,
	createDirectSummaryGenerator,
	createSessionCompaction,
	estimateCompactionTokens,
	isModelContextOverflowError,
	type ResolvedCompactionSettings,
	recoverContextOverflow,
	type SessionCompaction,
	SessionCompactionError,
	type SessionCompactionModule,
	useCompactionSettings,
} from "@/modules/sessions/compaction";
import {
	createSessionUserMessage,
	isSessionToolPart,
	isTerminalSessionToolPart,
	type SessionMessage,
	type SessionMessageMetadata,
	type SessionMessageTerminalOutcome,
	type SessionPart,
	type SessionToolPart,
	sanitizeInterruptedSessionMessages,
	sanitizeSessionSkillToolPart,
	sessionMessageSkillSchema,
} from "@/modules/sessions/message";
import {
	getSessionAttemptMessages,
	hasCompletedToolArtifact,
} from "@/modules/sessions/session-retry";
import { discoverSkillCatalog } from "@/modules/skills";
import { createToolGate, type ToolGate } from "@/modules/tool-gate/tool-gate";
import { useConfig } from "@/shared/config/config-provider";
import { useLatest } from "@/shared/hooks/use-latest";
import type { SessionId } from "@/shared/identifiers";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { buildAgent, type ResolvedCodingAgent } from "../../agents/built-ins";
import { resolveChatModelTarget } from "../../model-target";
import {
	createSessionEngine,
	type SessionChatStatus,
	type SessionCompactionCommand,
} from "../engine/session-engine";
import type { SessionFilePart } from "../message";
import { createSessionController } from "../session-controller";
import type {
	SessionOperation,
	SessionSendInput,
	SessionSendOutcome,
} from "../session-operation";
import type { AttachmentHydrationOptions } from "../storage/attachment-store";
import { getSessionStore } from "../storage/get-session-store";
import { buildUserSessionRecord } from "../storage/session-record";
import {
	type BeginTurnExecutionInput,
	createTurnExecution,
	type TurnExecution,
	type TurnExecutionHost,
	type TurnExecutionSkill,
} from "../turn-execution";
import { createDelegationExecutor, delegationThrough } from "./delegation";
import {
	buildAgentTurn,
	buildAssistantCancelledSessionRecord,
	buildAssistantFailureSessionRecord,
	buildTerminalSessionRecord,
	createGatedCodingTools,
	defaultRuntimeFactory,
	type RuntimeGatedTooling,
	runAgentTurnToText,
} from "./runtime-turn";

export const createChatMessageParts = (
	userText: string,
	fileMentions: SessionPart[],
	files: SessionFilePart[]
): SessionPart[] => [
	{ text: userText, type: "text" },
	...fileMentions,
	...files,
];

const AGENT_TURN_DEADLINE_MS = 43_200_000;
const INTERRUPTED_TOOL_ERROR = "Tool call interrupted";
const createEmptyRuntimeAssistantMessage = (
	assistantId: SessionMessageId,
	sourceUserMessageId: SessionMessageId | null,
	agent: AgentId,
	model: ChatModelSelection
): SessionMessage => ({
	id: assistantId,
	metadata: {
		agent,
		model,
		...(isNull(sourceUserMessageId) ? {} : { sourceUserMessageId }),
	},
	parts: [],
	role: "assistant",
});

const isBenignCompactionError = (error: unknown): boolean =>
	error instanceof SessionCompactionError &&
	(error.code === "history-too-short" || error.code === "not-needed");

/** Another compaction already carries the work this request asked for. */
const isInFlightCompaction = (error: unknown): boolean =>
	error instanceof SessionCompactionError && error.code === "in-flight";
/** Attachment hydration ceilings resolved for one submission. */
type AttachmentBudget = Pick<
	AttachmentHydrationOptions,
	"maxAttachments" | "maxBytes" | "maxTokens"
>;

/** One compaction request: the selection, intent, and inputs it runs with. */
type CompactOptions = {
	/** Replaces the Session Transcript before compaction when supplied. */
	compactionMessages?: readonly SessionMessage[];
	focus?: string;
	model: ChatModelSelection;
	nextMessages?: readonly SessionMessage[];
	trigger: CompactSessionInput["trigger"];
	variant?: ModelVariant;
};

type RunCompaction = (options: CompactOptions) => Promise<CompactSessionResult>;

type SubmitCompactionResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

const prepareCompactionBeforeSubmit = async ({
	activeMessages,
	compactionModule,
	model,
	runCompaction,
	settings,
	variant,
}: {
	activeMessages: readonly SessionMessage[];
	compactionModule: SessionCompactionModule;
	model: ChatModelSelection;
	runCompaction: RunCompaction;
	settings: ResolvedCompactionSettings;
	variant?: ModelVariant;
}): Promise<SubmitCompactionResult> => {
	if (
		!(
			settings.autoAvailable &&
			compactionModule.needsCompaction(activeMessages, settings)
		)
	) {
		return { ok: true };
	}
	try {
		await runCompaction({
			model,
			trigger: "threshold",
			...(isUndefined(variant) ? {} : { variant }),
		});
	} catch (cause) {
		if (!isBenignCompactionError(cause)) {
			return {
				ok: false,
				reason: getErrorMessage(cause, "Session compaction failed."),
			};
		}
	}
	return { ok: true };
};
type SubmitSkillResolution =
	| { readonly ok: true; readonly skill: SkillRequestContext | undefined }
	| { readonly ok: false; readonly reason: string };

type SubmitContextResult =
	| {
			readonly kind: "ready";
			readonly anchoredMessage?: SessionMessage;
			/** The Skill catalog armed for the Agent Turn this submission starts. */
			readonly armedSkill: TurnExecutionSkill;
			readonly metadata: SessionMessageMetadata;
			readonly resolvedAgent: ResolvedCodingAgent;
			readonly skill?: SkillRequestContext;
	  }
	| { readonly kind: "cancelled" }
	| { readonly kind: "rejected"; readonly reason: string };

type SubmitSkillExecutionFactory = () => Promise<TurnExecutionSkill>;
type SubmitSkillResolver = (
	explicitSkillInput: SkillContext | undefined,
	anchoredMessage: SessionMessage | undefined,
	armedSkill: TurnExecutionSkill
) => Promise<SubmitSkillResolution>;

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
	createTurnSkillExecution,
	input,
	resolveSkillForSubmit,
	signal,
}: {
	activeMessages: readonly SessionMessage[];
	createTurnSkillExecution: SubmitSkillExecutionFactory;
	input: SessionSendInput;
	resolveSkillForSubmit: SubmitSkillResolver;
	signal: AbortSignal;
}): Promise<SubmitContextResult> => {
	const armedSkill = await createTurnSkillExecution();
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
	const skillResolution = await resolveSkillForSubmit(
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

type NewSessionMessageResult =
	| { readonly kind: "ready"; readonly message: SessionMessage }
	| { readonly kind: "cancelled" }
	| { readonly kind: "rejected"; readonly reason: string };

const prepareNewSessionMessage = async ({
	input,
	metadata,
	signal,
}: {
	input: SessionSendInput;
	metadata: SessionMessageMetadata;
	signal: AbortSignal;
}): Promise<NewSessionMessageResult> => {
	const userText = input.userText;
	if (isUndefined(userText)) {
		return { kind: "rejected", reason: "No prompt to submit" };
	}
	const fileMentions = await resolveFileMentionParts(userText);
	const optimistic = createSessionUserMessage(
		userText,
		metadata,
		fileMentions,
		input.files ?? []
	);
	try {
		const [externalized] = await getSessionStore().externalizeAttachments(
			[optimistic],
			signal,
			{ rejectInvalid: true }
		);
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

const sessionSendCancelled = (signal?: AbortSignal): SessionSendOutcome => {
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
const handleRunTurnError = ({
	error,
	executionStarted,
	onProviderError,
	setError,
	signal,
}: {
	error: unknown;
	executionStarted: boolean;
	onProviderError: (error: unknown) => void;
	setError: (error: Error) => void;
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
	setError(normalizedError);
	if (!executionStarted) {
		return { rejected: true, reason: normalizedError.message };
	}
	onProviderError(error);
	return { rejected: false };
};

export const sanitizeSkillToolParts = (
	messages: SessionMessage[]
): SessionMessage[] =>
	messages.map((message) =>
		message.parts.some(isSkillToolPart)
			? {
					...message,
					parts: message.parts.map((part) =>
						isSkillToolPart(part) ? sanitizeSessionSkillToolPart(part) : part
					),
				}
			: message
	);

type PreparedModelMessages =
	| { readonly kind: "cancelled" }
	| {
			readonly kind: "ready";
			readonly messages: SessionMessage[];
			readonly newMessage?: SessionMessage;
	  }
	| { readonly kind: "rejected"; readonly reason: string };
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
		messages: sanitizeSkillToolParts(
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
	input,
	setPreparingMessage,
	signal,
}: {
	activeMessages: readonly SessionMessage[];
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	input: SessionSendInput;
	setPreparingMessage: (value: boolean) => void;
	signal: AbortSignal;
}): Promise<PreparedModelMessages> => {
	if (!(isUndefined(context.anchoredMessage) || isUndefined(input.messageId))) {
		return prepareRetryMessages(activeMessages, input.messageId);
	}

	setPreparingMessage(true);
	try {
		const preparedMessage = await prepareNewSessionMessage({
			input,
			metadata: context.metadata,
			signal,
		});
		if (preparedMessage.kind === "cancelled") {
			return preparedMessage;
		}
		if (preparedMessage.kind === "rejected") {
			return preparedMessage;
		}
		return {
			kind: "ready",
			messages: [
				...sanitizeSkillToolParts([...activeMessages]),
				preparedMessage.message,
			],
			newMessage: preparedMessage.message,
		};
	} finally {
		setPreparingMessage(false);
	}
};
type SessionPreparationResult =
	| {
			readonly kind: "cancelled";
	  }
	| {
			readonly error?: Error;
			readonly kind: "rejected";
			readonly reason: string;
	  }
	| {
			readonly attachmentBudget: AttachmentBudget;
			readonly context: Extract<SubmitContextResult, { kind: "ready" }>;
			readonly kind: "ready";
			readonly messages: SessionMessage[];
			readonly newMessage?: SessionMessage;
	  };

const prepareSessionSubmission = async ({
	getActiveMessages,
	compactionModule,
	createTurnSkillExecution,
	getCompactionSettings,
	input,
	runCompaction,
	resolveSkillForSubmit,
	setPreparingMessage,
	settleCompaction,
	signal,
}: {
	getActiveMessages: () => readonly SessionMessage[];
	compactionModule: SessionCompactionModule;
	createTurnSkillExecution: SubmitSkillExecutionFactory;
	getCompactionSettings: (
		selection: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	input: SessionSendInput;
	runCompaction: RunCompaction;
	resolveSkillForSubmit: SubmitSkillResolver;
	setPreparingMessage: (value: boolean) => void;
	settleCompaction: () => Promise<Error | null>;
	signal: AbortSignal;
}): Promise<SessionPreparationResult> => {
	try {
		// Settings and the attachment budget are resolved before anything joins a
		// compaction, so a compaction that starts while they resolve is joined by
		// the settle that follows rather than raced by this turn.
		const settings = await getCompactionSettings(input.model);
		const attachmentBudget: AttachmentBudget = {
			maxAttachments: settings.maxMediaAttachments,
			maxBytes: settings.maxMediaBytes,
			maxTokens: settings.maxMediaTokens,
		};
		const compactionError = await settleCompaction();
		if (
			!(isNull(compactionError) || isBenignCompactionError(compactionError))
		) {
			return {
				kind: "rejected",
				reason: getErrorMessage(compactionError, "Session compaction failed."),
			};
		}
		const compactionResult = await prepareCompactionBeforeSubmit({
			activeMessages: getActiveMessages(),
			compactionModule,
			model: input.model,
			runCompaction,
			settings,
			variant: input.variant,
		});
		if (!compactionResult.ok) {
			return { kind: "rejected", reason: compactionResult.reason };
		}
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		const context = await prepareSubmitContext({
			activeMessages: getActiveMessages(),
			createTurnSkillExecution,
			input,
			resolveSkillForSubmit,
			signal,
		});
		if (context.kind !== "ready") {
			return context;
		}
		const prepared = await prepareModelMessages({
			activeMessages: getActiveMessages(),
			context,
			input,
			setPreparingMessage,
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

const handleSafeAssistantOutcome = async ({
	agent,
	currentMessages,
	mergeTranscript,
	model,
	applyContext,
	record,
	setError,
	turnId,
	variant,
	commitRecord,
}: {
	agent: AgentId;
	currentMessages: readonly SessionMessage[];
	mergeTranscript: (messages: readonly SessionMessage[]) => void;
	record: SessionRecord;
	model: ChatModelSelection;
	applyContext: (messages: SessionMessage[]) => void;
	setError: (error: Error) => void;
	turnId: AgentTurnId;
	variant?: ModelVariant;
	commitRecord: (record: SessionRecord) => Promise<void>;
}): Promise<SessionSendOutcome> => {
	try {
		await commitRecord(record);
	} catch (commitError) {
		const safeError = new Error(
			"The Agent Turn outcome could not be persisted.",
			{ cause: commitError }
		);
		setError(safeError);
		return { rejected: true, reason: safeError.message };
	}
	const durableMessage = record.messages[0];
	const textPart = durableMessage?.parts.find((part) => part.type === "text");
	const terminal =
		record.outcome.kind === "assistant"
			? record.outcome.terminal.kind
			: "failed";
	const failureMessage: SessionMessage = {
		id: durableMessage?.id ?? toSessionMessageId(`assistant-${turnId}`),
		metadata: {
			agent,
			model,
			...(isUndefined(durableMessage?.metadata?.sourceUserMessageId)
				? {}
				: {
						sourceUserMessageId: durableMessage.metadata.sourceUserMessageId,
					}),
			...(terminal === "interrupted" ? { interrupted: true } : {}),
			...(terminal === "completed" ? {} : { terminalOutcome: terminal }),
			...(isUndefined(variant) ? {} : { variant }),
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
	applyContext(nextMessages);
	mergeTranscript([failureMessage]);
	return { rejected: false };
};

const handlePreExecutionTurnFailure = async ({
	agent,
	delegation,
	error,
	model,
	sourceUserMessageId,
	turnId,
	variant,
	commitRecord,
	currentMessages,
	mergeTranscript,
	applyContext,
	setError,
}: {
	agent: AgentId;
	delegation?: AgentTurnDelegation;
	error: unknown;
	model: ChatModelSelection;
	sourceUserMessageId?: SessionMessageId;
	turnId: AgentTurnId;
	variant?: ModelVariant;
	commitRecord: (record: SessionRecord) => Promise<void>;
	currentMessages: readonly SessionMessage[];
	mergeTranscript: (messages: readonly SessionMessage[]) => void;
	applyContext: (messages: SessionMessage[]) => void;
	setError: (error: Error) => void;
}): Promise<SessionSendOutcome> =>
	handleSafeAssistantOutcome({
		agent,
		commitRecord,
		currentMessages,
		mergeTranscript,
		model,
		applyContext,
		record: buildAssistantFailureSessionRecord({
			agentId: agent,
			delegation,
			error,
			model,
			sourceUserMessageId,
			turnId,
			variant,
		}),
		setError,
		turnId,
		variant,
	});

const handleTurnFailure = async ({
	agent,
	currentMessages,
	currentTurn,
	delegation,
	error,
	executionStarted,
	mergeTranscript,
	model,
	applyContext,
	setError,
	signal,
	sourceUserMessageId,
	terminalObserved,
	turnId,
	variant,
	onProviderError,
	commitRecord,
}: {
	agent: AgentId;
	currentMessages: readonly SessionMessage[];
	currentTurn?: AgentTurn;
	delegation?: AgentTurnDelegation;
	error: unknown;
	executionStarted: boolean;
	mergeTranscript: (messages: readonly SessionMessage[]) => void;
	model: ChatModelSelection;
	onProviderError: (error: unknown) => void;
	applyContext: (messages: SessionMessage[]) => void;
	setError: (error: Error) => void;
	signal: AbortSignal;
	sourceUserMessageId?: SessionMessageId;
	terminalObserved: boolean;
	turnId: AgentTurnId;
	variant?: ModelVariant;
	commitRecord: (record: SessionRecord) => Promise<void>;
}): Promise<SessionSendOutcome> => {
	if (!executionStarted) {
		if (signal.aborted) {
			return handleSafeAssistantOutcome({
				agent,
				commitRecord,
				currentMessages,
				mergeTranscript,
				model,
				applyContext,
				record: buildAssistantCancelledSessionRecord({
					agentId: agent,
					delegation,
					model,
					sourceUserMessageId,
					turnId,
					variant,
				}),
				setError,
				turnId,
				variant,
			});
		}
		return handlePreExecutionTurnFailure({
			agent,
			commitRecord,
			currentMessages,
			delegation,
			error,
			mergeTranscript,
			model,
			applyContext,
			setError,
			sourceUserMessageId,
			turnId,
			variant,
		});
	}
	if (!(terminalObserved || isUndefined(currentTurn))) {
		const fallbackRecord = signal.aborted
			? buildTerminalSessionRecord({
					assistantText: "",
					event: createAgentTurnAbortEvent(currentTurn, signal, 0),
					sourceUserMessageId,
					turn: currentTurn,
				})
			: buildAssistantFailureSessionRecord({
					agentId: agent,
					delegation,
					error,
					model,
					sourceUserMessageId,
					turnId,
					variant,
				});
		if (!isUndefined(fallbackRecord)) {
			return handleSafeAssistantOutcome({
				agent,
				commitRecord,
				currentMessages,
				mergeTranscript,
				model,
				applyContext,
				record: fallbackRecord,
				setError,
				turnId,
				variant,
			});
		}
	}
	if (signal.aborted) {
		return { rejected: false };
	}
	return handleRunTurnError({
		error,
		executionStarted,
		onProviderError,
		setError,
		signal,
	});
};
const updateRuntimeMessageFromEvent = ({
	event,
	execution,
	setStatus,
	updateRuntimeMessage,
}: {
	event: AgentTurnEvent;
	execution: TurnExecution;
	setStatus: (status: SessionChatStatus) => void;
	updateRuntimeMessage: (
		execution: TurnExecution,
		event: AgentTurnEvent
	) => void;
}): void => {
	updateRuntimeMessage(execution, event);
	if (event.type !== "agent-turn-started") {
		setStatus("streaming");
	}
};

export const findCurrentTurnAssistantIndex = (
	messages: readonly SessionMessage[]
): number => {
	const userIndex = messages.findLastIndex(({ role }) => role === "user");
	const assistantIndex = messages.findLastIndex(
		({ role }) => role === "assistant"
	);
	return assistantIndex > userIndex ? assistantIndex : -1;
};

const preserveInterruptedToolCall = (
	message: SessionMessage,
	toolCallId: ToolCallId
): SessionMessage => {
	if (message.role !== "assistant" || message.metadata?.interrupted !== true) {
		return message;
	}
	return {
		...message,
		parts: message.parts.map((part) =>
			isSessionToolPart(part) &&
			part.toolCallId === toolCallId &&
			part.state === "input-available"
				? {
						...part,
						errorText: INTERRUPTED_TOOL_ERROR,
						state: "output-error" as const,
					}
				: part
		),
	};
};

export const sanitizeInterruptedMessagesForSession = (
	messages: SessionMessage[],
	preserveToolCallId?: ToolCallId
): SessionMessage[] =>
	sanitizeInterruptedSessionMessages(
		messages.map((message) =>
			isUndefined(preserveToolCallId)
				? message
				: preserveInterruptedToolCall(message, preserveToolCallId)
		),
		preserveToolCallId
	);

export const findCurrentTurnInterruptTargetIndex = (
	messages: readonly SessionMessage[]
): number => {
	const assistantIndex = findCurrentTurnAssistantIndex(messages);
	return assistantIndex === -1
		? messages.findLastIndex(({ role }) => role === "user")
		: assistantIndex;
};

export const finalizeAssistantMessageMetadata = (
	message: SessionMessage,
	context: {
		agent: AgentId;
		model: ChatModelSelection;
		variant?: ModelVariant;
		interrupted: boolean;
		responseTimeMs?: number;
	}
): SessionMessage => {
	const variant = message.metadata?.variant ?? context.variant;
	const metadata: SessionMessageMetadata = {
		...(message.metadata ?? {}),
		agent: message.metadata?.agent ?? context.agent,
		interrupted: context.interrupted,
		model: message.metadata?.model ?? context.model,
		...(isUndefined(variant) ? {} : { variant }),
		...(isUndefined(context.responseTimeMs)
			? {}
			: { responseTimeMs: context.responseTimeMs }),
	};
	return { ...message, metadata };
};

export type ActivateExplicitSkillDeps = {
	execution: SkillExecution;
	gate: ToolGate;
};

export const activateExplicitSkill = async (
	skill: SkillContext,
	{ execution, gate }: ActivateExplicitSkillDeps
): Promise<
	{ ok: true; skill: SkillRequestContext } | { ok: false; reason: string }
> => {
	const entry = execution.catalog.entries.find(
		({ name }) => name === skill.name
	);
	const policyOutcome = await gate.gate({
		available: !isUndefined(entry),
		description: entry?.description ?? `Activate Skill ${skill.name}`,
		family: "skill",
		name: skill.name,
	});
	if (policyOutcome.kind !== "allow") {
		execution.markRejected(skill.name);
		return { ok: false, reason: policyOutcome.errorText };
	}
	if (isUndefined(entry)) {
		return {
			ok: false,
			reason: `Unknown or unavailable Skill "${skill.name}"`,
		};
	}
	const result = execution.activate(entry.name, "explicit");
	if (result.status !== "loaded") {
		return {
			ok: false,
			reason: `Skill "${entry.name}" could not be activated`,
		};
	}
	return {
		ok: true,
		skill: {
			arguments: skill.arguments,
			contentHash: result.snapshot.contentHash,
			instructions: result.snapshot.body,
			name: entry.name,
			source: "explicit",
		},
	};
};

const isCodingToolName = (name: string): name is CodingToolName =>
	codingToolNames.some((candidate) => candidate === name);

const runtimeToolPart = (
	event: Extract<AgentTurnEvent, { type: "tool-call-started" }>
) => {
	if (isCodingToolName(event.toolName)) {
		return {
			input: event.input,
			state: "input-available" as const,
			toolCallId: event.toolCallId,
			type: `tool-${event.toolName}` as `tool-${CodingToolName}`,
		};
	}
	return {
		input: event.input,
		state: "input-available" as const,
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		type: "dynamic-tool" as const,
	};
};

type RuntimeToolFinishedEvent = Extract<
	AgentTurnEvent,
	{ type: "tool-call-finished" }
>;

const settleRuntimeToolPart = (
	part: SessionToolPart,
	event: RuntimeToolFinishedEvent
): SessionToolPart =>
	event.outcome.type === "success"
		? {
				...part,
				output: event.outcome.output,
				state: "output-available",
			}
		: {
				...part,
				errorText: event.outcome.errorText,
				state: "output-error",
			};

const runtimeToolResultPart = (
	event: RuntimeToolFinishedEvent
): SessionToolPart =>
	event.outcome.type === "success"
		? {
				input: undefined,
				output: event.outcome.output,
				state: "output-available",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				type: "dynamic-tool",
			}
		: {
				errorText: event.outcome.errorText,
				state: "output-error",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				type: "dynamic-tool",
			};

const terminalOutcomeForEvent = (
	event: AgentTurnTerminalEvent
): SessionMessageTerminalOutcome | undefined => {
	if (event.type === "agent-turn-completed") {
		return;
	}
	if (event.type === "agent-turn-cancelled") {
		return "cancelled";
	}
	if (event.type === "agent-turn-failed") {
		return "failed";
	}
	return "interrupted";
};
const buildTerminalMessageMetadata = ({
	agent,
	base,
	event,
	model,
	startedAt,
	usage,
	variant,
}: {
	agent: AgentId;
	base: SessionMessage;
	event: AgentTurnTerminalEvent;
	model?: ChatModelSelection;
	startedAt: number | null;
	usage: ModelUsage | null;
	variant?: ModelVariant;
}): SessionMessageMetadata => {
	const terminalOutcome = terminalOutcomeForEvent(event);
	return {
		...(base.metadata ?? {}),
		agent: base.metadata?.agent ?? agent,
		interrupted: event.type === "agent-turn-interrupted",
		...(isUndefined(terminalOutcome) ? {} : { terminalOutcome }),
		...(isUndefined(model) ? {} : { model: base.metadata?.model ?? model }),
		...(isUndefined(variant)
			? {}
			: { variant: base.metadata?.variant ?? variant }),
		...(isNull(startedAt)
			? {}
			: { responseTimeMs: Math.max(0, Date.now() - startedAt) }),
		...(isNull(usage) ? {} : { usage }),
	};
};

const sanitizeFailedRuntimeMessages = (
	messages: readonly SessionMessage[],
	assistantId: string,
	failureText: string
): SessionMessage[] =>
	messages.map((message) => {
		if (message.id !== assistantId || message.role !== "assistant") {
			return message;
		}
		const terminalToolParts = message.parts.filter(
			(part): part is SessionToolPart =>
				isSessionToolPart(part) && isTerminalSessionToolPart(part)
		);
		return {
			...message,
			parts: [{ text: failureText, type: "text" }, ...terminalToolParts],
		};
	});

const sanitizeRuntimeMessagesForTerminal = (
	messages: readonly SessionMessage[],
	assistantId: SessionMessageId,
	event: AgentTurnTerminalEvent
): SessionMessage[] => {
	if (event.type === "agent-turn-completed") {
		return [...messages];
	}
	if (event.type === "agent-turn-interrupted") {
		return sanitizeInterruptedSessionMessages(messages);
	}
	return sanitizeFailedRuntimeMessages(
		messages,
		assistantId,
		event.failure.message
	);
};
/**
 * The Agent Turn execution a submission starts: its Agent and Model Target
 * selection, the session-level selection its records carry, its Skill, and its
 * source user message identity.
 */
const executionInputForSubmit = ({
	input,
	readyContext,
	sourceUserMessageId,
	startedAt,
}: {
	input: SessionSendInput;
	readyContext: Extract<SubmitContextResult, { kind: "ready" }>;
	sourceUserMessageId?: SessionMessageId;
	startedAt: number;
}): BeginTurnExecutionInput => ({
	agent: input.agent,
	armedSkill: readyContext.armedSkill,
	model: input.model,
	resolvedAgent: readyContext.resolvedAgent,
	sessionModel: input.sessionModel,
	startedAt,
	...(isUndefined(input.delegation) ? {} : { parent: input.delegation }),
	...(isUndefined(input.sessionVariant)
		? {}
		: { sessionVariant: input.sessionVariant }),
	...(isUndefined(readyContext.skill)
		? {}
		: { skillRequest: readyContext.skill }),
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
}: {
	agent: AgentId;
	message: SessionMessage;
	model: ChatModelSelection;
	sessionId: SessionId;
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	variant?: ModelVariant;
}): Promise<Error | null> => {
	try {
		await getSessionStore().commitSessionRecord({
			sessionModel,
			sessionVariant,
			record: buildUserSessionRecord({
				agentId: agent,
				message,
				model,
				turnId: createAgentTurnId(),
				variant,
			}),
			sessionId,
		});
		return null;
	} catch (error) {
		return isError(error) ? error : new Error("Could not save the prompt.");
	}
};

export function useChat(
	sessionId: SessionId,
	initialMessages: SessionMessage[],
	initialActiveMessages: SessionMessage[] = initialMessages,
	initialCompactions: SessionCompaction[] = []
) {
	const connections = useConnections();
	const mcp = useMcp();
	const config = useConfig();
	const configRef = useLatest(config);
	const { getCompactionSettings: getSettingsForModel } =
		useCompactionSettings();
	const registry = useAgentRegistry();
	const registryRef = useLatest(registry);
	const {
		closeApprovals,
		openApproval,
		resolveMcpPolicyForAgent,
		resolvePermission,
		resolvePermissionForAgent,
		resolveResourceLimits,
		resolveResourceLimitsForAgent,
		sandbox,
		service,
	} = useToolPermission();
	const resolveMcpPolicyForAgentRef = useLatest(resolveMcpPolicyForAgent);
	const resolvePermissionForAgentRef = useLatest(resolvePermissionForAgent);
	const resolveResourceLimitsForAgentRef = useLatest(
		resolveResourceLimitsForAgent
	);
	const resolvePermissionRef = useLatest(resolvePermission);
	const resolveResourceLimitsRef = useLatest(resolveResourceLimits);
	/**
	 * The Agent Turn execution the session is currently running, kept so
	 * session-level operations (interrupt, the compaction reserve, and Tool Gate
	 * aborts) can reach the execution that owns the work. Turn-scoped values
	 * themselves live in the execution scope, never here.
	 */
	const primaryExecutionRef = useRef<TurnExecution | null>(null);
	const approvalAbortHandledRef = useRef(false);
	const abortApprovalTurnRef = useRef<(toolCallId: ToolCallId) => void>(
		() => undefined
	);
	const toolGateState = useMemo(() => {
		const approvalQueue = createApprovalQueue<ToolApprovalRequest>();
		return {
			approvalQueue,
			gate: createToolGate({
				approvalQueue,
				onAbort: (request) => {
					if (isUndefined(request.toolCallId)) {
						return;
					}
					const abortChild = primaryExecutionRef.current?.childAborts.get(
						request.toolCallId
					);
					if (!isUndefined(abortChild)) {
						abortChild();
						return;
					}
					abortApprovalTurnRef.current(request.toolCallId);
				},
				openApproval,
				resolvePermission: (agentId) =>
					isUndefined(agentId)
						? resolvePermissionRef.current()
						: resolvePermissionForAgentRef.current(agentId),
				resolveResourceLimits: (agentId) =>
					isUndefined(agentId)
						? resolveResourceLimitsRef.current()
						: resolveResourceLimitsForAgentRef.current(agentId),
				sandbox,
				service,
			}),
			scope: sessionId,
		};
	}, [openApproval, sandbox, service, sessionId]);
	const approvalPanels = useApprovalPanels();
	const approvalPanelsRef = useLatest(approvalPanels);
	const approvalQueueRef = useLatest(toolGateState.approvalQueue);
	const closeApprovalsRef = useLatest(closeApprovals);
	useEffect(
		() => () => {
			toolGateState.approvalQueue.rejectAll();
			closeApprovals();
		},
		[closeApprovals, toolGateState]
	);

	const estimateRuntimeRequestOverheadTokens = useCallback((): number => {
		const execution = primaryExecutionRef.current;
		const resolvedAgent = execution?.resolvedAgent;
		const codingTools =
			resolvedAgent?.visibleCodingTools.map((name) => {
				const definition = codingToolDefinitions[name];
				return { description: definition.description, name };
			}) ?? [];
		const skillTool = execution?.armedSkill?.tool;
		const serializedContext = JSON.stringify({
			agentInstructions: resolvedAgent?.instructions ?? "",
			codingTools,
			mcpTools: execution?.mcpSnapshot?.manifest ?? [],
			skillTool: skillTool
				? {
						description: skillTool.description,
						inputSchema: skillTool.inputSchema,
						name: skillTool.name,
					}
				: null,
		});
		// Compaction must reserve the bounded project block for the next normal turn.
		return (
			COMPACTION_REQUEST_OVERHEAD_TOKENS +
			Math.ceil(MAX_PROJECT_INSTRUCTION_TOTAL_BYTES / 4) +
			Math.ceil(serializedContext.length / 4)
		);
	}, []);
	const summaryGenerator = useMemo(
		() => createDirectSummaryGenerator(connections),
		[connections]
	);
	const compactionModule = useMemo(
		() =>
			createSessionCompaction({
				attachmentStore: getSessionStore().attachmentStore,
				estimateTokens: (messages) => estimateCompactionTokens(messages),
				store: getSessionStore(),
				summaryGenerator,
			}),
		[summaryGenerator]
	);
	const getCompactionSettings = useCallback(
		(selection: ChatModelSelection) => getSettingsForModel(selection),
		[getSettingsForModel]
	);
	/**
	 * The settings one compaction command runs with: the resolved compaction
	 * settings plus the request overhead of the Agent Turn execution in flight.
	 */
	const compactionSettingsFor = useCallback(
		async (
			model: ChatModelSelection
		): Promise<SessionCompactionCommand["settings"]> => {
			const settings = await getCompactionSettings(model);
			return {
				compactionOverheadTokens: estimateRuntimeRequestOverheadTokens(),
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
		[estimateRuntimeRequestOverheadTokens, getCompactionSettings]
	);

	const [engine] = useState(() =>
		createSessionEngine({
			compaction: compactionModule,
			initialCompactions,
			initialContext: initialActiveMessages,
			initialTranscript: initialMessages,
			sessionId,
		})
	);
	const {
		applyContext,
		beginExecution,
		endExecution,
		getSnapshot,
		mergeTranscript,
		setCatalogDiagnostic,
		setCompactionError,
		setError,
		setExecutionViewState,
		setPreparingMessage,
		setStatus,
	} = engine;
	// Bound through a subscription rather than `useSyncExternalStore`: the
	// synchronous re-render that hook performs inside the submit path stalls the
	// automatic-compaction journey in the OpenTUI test renderer (`useSyncExternalStore`
	// does receive updates in this renderer in isolation, so this is about that
	// interaction, not about the renderer dropping notifications). The engine
	// stays the only writer; this hook mirrors its Session Snapshot for
	// rendering and re-reads it once after subscribing so a change between render
	// and effect is not lost.
	const [state, setState] = useState(getSnapshot);
	useEffect(() => {
		setState(getSnapshot());
		return engine.subscribe(() => setState(getSnapshot()));
	}, [engine, getSnapshot]);
	const overflowAttemptRef = useRef(0);
	const sessionRef = useRef<SessionOperation | null>(null);
	const providerErrorRef = useRef<
		(error: unknown, execution: TurnExecution) => void
	>(() => undefined);

	/**
	 * Starts an Agent Turn execution: its scope and its engine registration are
	 * created together, and its delegation bookkeeping is created with it before
	 * the turn runs, so a re-render can neither rebuild nor reset either.
	 */
	const startExecution = useCallback(
		(input: BeginTurnExecutionInput): TurnExecution => {
			const execution = createTurnExecution(input);
			if (isUndefined(execution.parent)) {
				primaryExecutionRef.current = execution;
			}
			beginExecution(execution);
			return execution;
		},
		[beginExecution]
	);
	const endExecutionScope = useCallback(
		(execution: TurnExecution): void => {
			const snapshot = execution.mcpSnapshot;
			if (!isNull(snapshot)) {
				mcp.releaseSnapshot?.(snapshot);
				execution.mcpSnapshot = null;
			}
			endExecution(execution.turnId);
		},
		[endExecution, mcp]
	);
	const executionHost = useMemo<TurnExecutionHost>(
		() => ({
			begin: startExecution,
			end: endExecutionScope,
			publishViewState: (execution, viewState) =>
				setExecutionViewState(execution.turnId, viewState),
		}),
		[endExecutionScope, setExecutionViewState, startExecution]
	);
	const runCompaction = useCallback(
		async ({
			compactionMessages,
			focus,
			model,
			nextMessages,
			trigger,
			variant,
		}: CompactOptions): Promise<CompactSessionResult> =>
			await engine.compact({
				model,
				settings: await compactionSettingsFor(model),
				trigger,
				...(isUndefined(compactionMessages)
					? {}
					: { sourceMessages: compactionMessages }),
				...(isUndefined(focus) ? {} : { focus }),
				...(isUndefined(nextMessages) ? {} : { nextMessages }),
				...(isUndefined(variant) ? {} : { variant }),
			}),
		[compactionSettingsFor, engine]
	);
	const cancelCompaction = useCallback(() => {
		engine.cancelCompaction();
	}, [engine]);
	const settleCompaction = useCallback(
		() => engine.settleCompaction(),
		[engine]
	);
	const maintainAfterTurn = useCallback(
		(
			messages: readonly SessionMessage[],
			selection: ChatModelSelection,
			variant?: ModelVariant
		) => {
			const compactIfNeeded = async (): Promise<void> => {
				const settings = await getCompactionSettings(selection);
				if (
					!(
						settings.autoAvailable &&
						compactionModule.needsCompaction(messages, settings)
					)
				) {
					return;
				}
				try {
					await runCompaction({
						model: selection,
						nextMessages: messages,
						trigger: "threshold",
						...(isUndefined(variant) ? {} : { variant }),
					});
				} catch (error) {
					// A compaction already in flight owns the Session Context swap;
					// the next submission re-checks the threshold and compacts then.
					if (
						!(isBenignCompactionError(error) || isInFlightCompaction(error))
					) {
						setCompactionError(
							isError(error) ? error : new Error("Automatic compaction failed.")
						);
					}
				}
			};
			void compactIfNeeded();
		},
		[compactionModule, getCompactionSettings, runCompaction, setCompactionError]
	);

	const createTurnSkillExecution =
		useCallback(async (): Promise<TurnExecutionSkill> => {
			const permission = await resolvePermission();
			const catalog = await discoverSkillCatalog(config, (name) =>
				permission.decide("skill", name)
			);
			const execution = createSkillExecution(catalog);
			const tool = buildSkillToolDefinition(catalog);
			setCatalogDiagnostic(summarizeCatalogDiagnostics(catalog));
			return {
				execution,
				...(isUndefined(tool) ? {} : { tool }),
			};
		}, [config, resolvePermission, setCatalogDiagnostic]);

	const resolveSkillForSubmit = useCallback(
		async (
			explicitSkillInput: SkillContext | undefined,
			anchoredMessage: SessionMessage | undefined,
			armedSkill: TurnExecutionSkill
		): Promise<
			| { ok: true; skill: SkillRequestContext | undefined }
			| { ok: false; reason: string }
		> => {
			const execution = armedSkill.execution;
			if (!isUndefined(explicitSkillInput)) {
				return activateExplicitSkill(explicitSkillInput, {
					execution,
					gate: toolGateState.gate,
				});
			}
			if (isUndefined(anchoredMessage)) {
				return { ok: true, skill: undefined };
			}
			const parsedSkill = sessionMessageSkillSchema.safeParse(
				anchoredMessage.metadata?.skill
			);
			if (!parsedSkill.success) {
				return { ok: true, skill: undefined };
			}
			if (!("instructions" in parsedSkill.data)) {
				const live = execution.catalog.entries.find(
					({ name }) => name === parsedSkill.data.name
				);
				if (isUndefined(live)) {
					return {
						ok: false,
						reason: `Skill "${parsedSkill.data.name}" is unavailable`,
					};
				}
				return activateExplicitSkill(
					{
						arguments: parsedSkill.data.arguments ?? "",
						instructions: "",
						name: parsedSkill.data.name,
					},
					{ execution, gate: toolGateState.gate }
				);
			}
			return activateExplicitSkill(parsedSkill.data, {
				execution,
				gate: toolGateState.gate,
			});
		},
		[toolGateState.gate]
	);

	const updateRuntimeMessage = useCallback(
		(execution: TurnExecution, event: AgentTurnEvent): void => {
			const current = getSnapshot().context;
			const index = current.findIndex(({ id }) => id === execution.assistantId);
			const emptyMessage = createEmptyRuntimeAssistantMessage(
				execution.assistantId,
				execution.sourceUserMessageId,
				execution.agent,
				execution.model
			);
			const existing: SessionMessage =
				index === -1 ? emptyMessage : (current[index] ?? emptyMessage);
			const parts = [...existing.parts];
			switch (event.type) {
				case "model-step-started":
					parts.push({ type: "step-start" });
					break;
				case "reasoning-delta": {
					const last = parts.at(-1);
					if (last?.type === "reasoning") {
						parts[parts.length - 1] = {
							...last,
							text: last.text + event.delta,
						};
					} else {
						parts.push({ text: event.delta, type: "reasoning" });
					}
					break;
				}
				case "text-delta": {
					const last = parts.at(-1);
					if (last?.type === "text") {
						parts[parts.length - 1] = {
							...last,
							text: last.text + event.delta,
						};
					} else {
						parts.push({ text: event.delta, type: "text" });
					}
					break;
				}
				case "tool-call-started":
					parts.push(runtimeToolPart(event));
					break;
				case "tool-call-finished": {
					const partIndex = parts.findLastIndex(
						(part) =>
							isSessionToolPart(part) && part.toolCallId === event.toolCallId
					);
					const existingPart = parts[partIndex];
					if (
						partIndex === -1 ||
						isUndefined(existingPart) ||
						!isSessionToolPart(existingPart)
					) {
						parts.push(runtimeToolResultPart(event));
					} else {
						parts[partIndex] = settleRuntimeToolPart(existingPart, event);
					}
					break;
				}
				default:
					return;
			}
			const nextMessage: SessionMessage = { ...existing, parts };
			const nextMessages =
				index === -1
					? [...current, nextMessage]
					: current.map((message, messageIndex) =>
							messageIndex === index ? nextMessage : message
						);
			applyContext(nextMessages);
			mergeTranscript([nextMessage]);
		},
		[mergeTranscript, applyContext, getSnapshot]
	);

	const finalizeRuntimeMessage = useCallback(
		(execution: TurnExecution, event: AgentTurnTerminalEvent): void => {
			const current = getSnapshot().context;
			const index = current.findIndex(({ id }) => id === execution.assistantId);
			const base =
				index === -1
					? createEmptyRuntimeAssistantMessage(
							execution.assistantId,
							execution.sourceUserMessageId,
							execution.agent,
							execution.model
						)
					: current[index];
			if (isUndefined(base)) {
				return;
			}
			const usage =
				event.type === "agent-turn-completed"
					? normalizeModelUsage(event.usage)
					: null;
			const metadata = buildTerminalMessageMetadata({
				agent: execution.agent,
				base,
				event,
				model: execution.model,
				startedAt: execution.startedAt,
				usage,
				variant: execution.variant,
			});
			const nextMessage = { ...base, metadata };
			const nextMessages =
				index === -1
					? [...current, nextMessage]
					: current.map((message, messageIndex) =>
							messageIndex === index ? nextMessage : message
						);
			const safeMessages = sanitizeRuntimeMessagesForTerminal(
				nextMessages,
				execution.assistantId,
				event
			);
			applyContext(safeMessages);
			mergeTranscript(safeMessages);
		},
		[mergeTranscript, applyContext, getSnapshot]
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: latest-value refs intentionally keep turn callbacks current without rebuilding the turn.
	const runTurn = useCallback(
		async ({
			attachmentBudget,
			execution,
			modelMessages,
			signal,
		}: {
			attachmentBudget: AttachmentBudget;
			execution: TurnExecution;
			modelMessages: readonly SessionMessage[];
			signal: AbortSignal;
		}): Promise<SessionSendOutcome> => {
			setError(null);
			setStatus("submitted");
			const store = getSessionStore();
			const {
				agent,
				model,
				resolvedAgent,
				skillRequest,
				sourceUserMessageId,
				turnId,
				variant,
			} = execution;
			const delegation = execution.parent;
			const sourceUserMessage = isNull(sourceUserMessageId)
				? {}
				: { sourceUserMessageId };
			let executionStarted = false;
			let currentTurn: AgentTurn | undefined;
			let terminalObserved = false;
			const commitRecord = (record: SessionRecord) =>
				store.commitSessionRecord({
					...(isUndefined(delegation)
						? {
								sessionModel: execution.sessionModel,
								sessionVariant: execution.sessionVariant,
							}
						: {}),
					record,
					sessionId,
				});
			try {
				if (isUndefined(resolvedAgent)) {
					throw new Error("The resolved Agent is unavailable.");
				}
				const modelTarget = await resolveChatModelTarget(model, connections, {
					signal,
					...(isUndefined(variant) ? {} : { variant }),
				});
				const mcpPolicy = await resolveMcpPolicyForAgentRef.current(agent);
				const snapshot = await mcp.createSnapshot(agent, mcpPolicy);
				execution.mcpSnapshot = snapshot;
				const hydratedMessages = await store.hydrateAttachments(modelMessages, {
					...attachmentBudget,
					purpose: "model",
					priorityMessageId: modelMessages.findLast(
						({ role }) => role === "user"
					)?.id,
					signal,
				});
				const executeMcpTool = createMcpToolExecutor(mcp.execute);
				const tooling: RuntimeGatedTooling = {
					gate: toolGateState.gate,
					mcpSnapshot: snapshot,
					executeMcpTool,
					registerChildAbort: (toolCallId, abort) => {
						execution.childAborts.set(toolCallId, abort);
						return () => execution.childAborts.delete(toolCallId);
					},
					resolveResourceLimits: (agentId) =>
						isUndefined(agentId)
							? resolveResourceLimitsRef.current()
							: resolveResourceLimitsForAgentRef.current(agentId),
				};
				execution.delegate = createDelegationExecutor({
					connections,
					createSkillContext: async (agentId) => {
						const permission =
							await resolvePermissionForAgentRef.current(agentId);
						const catalog = await discoverSkillCatalog(
							configRef.current,
							(name) => permission.decide("skill", name)
						);
						const skillExecution = createSkillExecution(catalog);
						const skillTool = buildSkillToolDefinition(catalog);
						return isUndefined(skillTool)
							? undefined
							: { execution: skillExecution, tool: skillTool };
					},
					cwd: configRef.current.cwd,
					execution,
					host: executionHost,
					mcp,
					registry: registryRef.current,
					resolveMcpPolicyForAgent: (agentId) =>
						resolveMcpPolicyForAgentRef.current(agentId),
					resolvePermissionForAgent: (agentId) =>
						resolvePermissionForAgentRef.current(agentId),
					sessionId,
					tooling,
					workspace: configRef.current.workspace,
				});
				const tools = createGatedCodingTools({
					agentId: agent,
					agentTools: resolvedAgent.visibleCodingTools,
					delegate:
						registryRef.current?.agents.some(
							({ isAvailable, role }) =>
								isAvailable && (role === "subagent" || role === "all")
						) === true
							? delegationThrough(execution)
							: undefined,
					executeMcpTool,
					gate: tooling.gate,
					mcpSnapshot: snapshot,
					parentTurnId: turnId,
					resolveResourceLimits: tooling.resolveResourceLimits,
					skillExecution: execution.armedSkill?.execution,
					skillTool: execution.armedSkill?.tool,
				});
				const agentPermission =
					await resolvePermissionForAgentRef.current(agent);
				const prompt = await prepareAgentTurnPrompt({
					agent: resolvedAgent,
					cwd: configRef.current.cwd,
					delegation,
					mcpTools: snapshot.tools,
					model: {
						modelId: modelTarget.modelId,
						providerId: modelTarget.providerId,
					},
					permission: agentPermission,
					tools,
					workspace: configRef.current.workspace,
				});
				const turn = buildAgentTurn({
					agent,
					delegation,
					modelMessages: hydratedMessages,
					modelTarget,
					resolvedAgent,
					skill: skillRequest,
					systemInstructions: prompt.instructions,
					tools,
					turnId,
				});
				currentTurn = turn;
				await runAgentTurnToText({
					onCheckpoint: commitRecord,
					onEvent: (event) => {
						executionStarted = true;
						updateRuntimeMessageFromEvent({
							event,
							execution,
							setStatus,
							updateRuntimeMessage,
						});
					},
					...sourceUserMessage,
					onTerminal: (event) => {
						executionStarted = true;
						terminalObserved = true;
						finalizeRuntimeMessage(execution, event);
					},
					onToolCheckpoint: commitRecord,
					onViewState: (viewState) =>
						executionHost.publishViewState(execution, viewState),
					runtime: defaultRuntimeFactory(),
					signal,
					turn,
				});
				setStatus("ready");
				maintainAfterTurn(getSnapshot().transcript, model, variant);
				return { rejected: false };
			} catch (turnError) {
				setStatus("ready");
				return handleTurnFailure({
					agent,
					commitRecord,
					currentMessages: getSnapshot().context,
					currentTurn,
					delegation,
					error: turnError,
					executionStarted,
					mergeTranscript,
					model,
					onProviderError: (error) =>
						providerErrorRef.current(error, execution),
					applyContext,
					setError,
					signal,
					terminalObserved,
					turnId,
					variant,
					...sourceUserMessage,
				});
			} finally {
				endExecutionScope(execution);
			}
		},
		[
			connections,
			endExecutionScope,
			executionHost,
			finalizeRuntimeMessage,
			maintainAfterTurn,
			mcp,
			mergeTranscript,
			applyContext,
			resolveMcpPolicyForAgentRef,
			resolveResourceLimitsForAgentRef,
			resolveResourceLimitsRef,
			sessionId,
			toolGateState.gate,
			updateRuntimeMessage,
		]
	);

	const submit = useCallback(
		async (
			input: SessionSendInput,
			signal: AbortSignal
		): Promise<SessionSendOutcome> => {
			setCompactionError(null);
			approvalAbortHandledRef.current = false;
			overflowAttemptRef.current = 0;
			const startedAt = Date.now();

			const prepared = await prepareSessionSubmission({
				getActiveMessages: () => getSnapshot().context,
				compactionModule,
				createTurnSkillExecution,
				getCompactionSettings,
				input,
				runCompaction,
				resolveSkillForSubmit,
				setPreparingMessage,
				settleCompaction,
				signal,
			});
			if (prepared.kind !== "ready") {
				if (prepared.kind === "rejected" && !isUndefined(prepared.error)) {
					setError(prepared.error);
				}
				return sessionOutcomeForPreparation(prepared, signal);
			}
			const { context: readyContext, messages: modelMessages } = prepared;
			if (!isUndefined(prepared.newMessage)) {
				const promptError = await commitPromptRecord({
					agent: input.agent,
					message: prepared.newMessage,
					model: input.model,
					sessionId,
					sessionModel: input.sessionModel,
					...(isUndefined(input.sessionVariant)
						? {}
						: { sessionVariant: input.sessionVariant }),
					...(isUndefined(input.variant) ? {} : { variant: input.variant }),
				});
				if (!isNull(promptError)) {
					setError(promptError);
					return { rejected: true, reason: "Could not save the prompt." };
				}
			}
			applyContext(modelMessages);
			mergeTranscript(modelMessages);
			const execution = startExecution(
				executionInputForSubmit({
					input,
					readyContext,
					sourceUserMessageId:
						readyContext.anchoredMessage?.id ?? prepared.newMessage?.id,
					startedAt,
				})
			);
			return runTurn({
				attachmentBudget: prepared.attachmentBudget,
				execution,
				modelMessages,
				signal,
			});
		},
		[
			compactionModule,
			createTurnSkillExecution,
			getCompactionSettings,
			mergeTranscript,
			applyContext,
			resolveSkillForSubmit,
			runCompaction,
			runTurn,
			sessionId,
			setCompactionError,
			setError,
			setPreparingMessage,
			settleCompaction,
			getSnapshot,
			startExecution,
		]
	);
	const submitRef = useLatest(submit);

	const interruptLatestAssistantMessage = useCallback(
		(preserveToolCallId?: ToolCallId): void => {
			const targetIndex = findCurrentTurnInterruptTargetIndex(
				getSnapshot().context
			);
			if (targetIndex === -1) {
				return;
			}
			const target = getSnapshot().context[targetIndex];
			if (isUndefined(target)) {
				return;
			}
			const execution = primaryExecutionRef.current;
			const finalized = finalizeAssistantMessageMetadata(target, {
				agent: execution?.agent ?? buildAgent.id,
				interrupted: true,
				model: execution?.model ?? defaultChatModelSelection,
				variant: execution?.variant,
				...(isNull(execution)
					? {}
					: { responseTimeMs: Math.max(0, Date.now() - execution.startedAt) }),
			});
			const next = [...getSnapshot().context];
			next[targetIndex] = finalized;
			const sanitized = sanitizeInterruptedMessagesForSession(
				next,
				preserveToolCallId
			);
			applyContext(sanitized);
			mergeTranscript(sanitized);
		},
		[mergeTranscript, applyContext, getSnapshot]
	);
	const abortApprovalTurn = useCallback(
		(toolCallId: ToolCallId): void => {
			if (approvalAbortHandledRef.current) {
				return;
			}
			approvalAbortHandledRef.current = true;
			toolGateState.approvalQueue.rejectAll();
			closeApprovals();
			interruptLatestAssistantMessage(toolCallId);
		},
		[closeApprovals, interruptLatestAssistantMessage, toolGateState]
	);
	abortApprovalTurnRef.current = abortApprovalTurn;

	providerErrorRef.current = (providerError, execution) => {
		if (
			overflowAttemptRef.current > 0 ||
			!isModelContextOverflowError(providerError)
		) {
			return;
		}
		overflowAttemptRef.current = 1;
		const failedModel = execution.model;
		const originalMessage = getSnapshot().transcript.findLast(
			(message) => message.role === "user"
		);
		if (isUndefined(originalMessage)) {
			return;
		}
		void (async () => {
			const settings = await getCompactionSettings(failedModel);
			if (!settings.overflowRecoveryAvailable) {
				return;
			}
			try {
				await recoverContextOverflow({
					attempt: 0,
					compact: (input) =>
						runCompaction({
							compactionMessages: input.session.messages,
							model: input.model,
							trigger: "overflow",
							...(isUndefined(execution.variant)
								? {}
								: { variant: execution.variant }),
						}),
					compaction: compactionModule,
					compactionInput: {
						model: failedModel,
						settings: {
							compactionOverheadTokens: estimateRuntimeRequestOverheadTokens(),
							enabled: settings.enabled,
							keepRecentTokens: settings.keepRecentTokens,
							maxMediaAttachments: settings.maxMediaAttachments,
							maxMediaBytes: settings.maxMediaBytes,
							maxMediaTokens: settings.maxMediaTokens,
							modelContextLimit: settings.modelContextLimit,
							reserveTokens: settings.reserveTokens,
							thresholdTokens: settings.thresholdTokens,
						},
					},
					session: {
						messages: getSnapshot().transcript,
						sessionId,
					},
					enabled: settings.overflowRecoveryAvailable,
					error: providerError,
					originalMessageId: originalMessage.id,
					replay: async ({ originalMessageId }) => {
						// The compaction command published the Session Context swap
						// and the entry it produced before this replay runs.
						const operation = sessionRef.current;
						if (isNull(operation) || !(await operation.waitForIdle())) {
							return;
						}
						const outcome = await operation.send({
							agent: execution.agent,
							sessionModel: execution.sessionModel,
							sessionVariant: execution.sessionVariant,
							messageId: originalMessageId,
							model: failedModel,
							resolvedAgent: execution.resolvedAgent,
							variant: execution.variant,
						});
						if (outcome.rejected) {
							throw new Error(outcome.reason);
						}
					},
				});
			} catch (recoveryError) {
				setCompactionError(
					isError(recoveryError)
						? recoveryError
						: new Error("Context overflow recovery failed.")
				);
			}
		})();
	};

	const session = useMemo(
		() =>
			createSessionController({
				deadlineMs: AGENT_TURN_DEADLINE_MS,
				execute: async (input, signal) => {
					if (signal.aborted) {
						return sessionSendCancelled(signal);
					}
					const stop = (): void => {
						cancelCompaction();
						approvalQueueRef.current.rejectAll();
						closeApprovalsRef.current();
					};
					signal.addEventListener("abort", stop, { once: true });
					try {
						return await submitRef.current(input, signal);
					} finally {
						signal.removeEventListener("abort", stop);
					}
				},
				onInterrupt: interruptLatestAssistantMessage,
				onError: (error) =>
					setError(isError(error) ? error : new Error("Session failed.")),
				resolveApproval: async (approvalId, outcome) => {
					const entry = approvalPanelsRef.current.entries.find(
						(candidate) => candidate.id === approvalId
					);
					if (isUndefined(entry)) {
						throw new Error(`Session approval "${approvalId}" is unavailable.`);
					}
					if (outcome.decision === "allow") {
						entry.actions.allow(outcome.remember);
					} else if (outcome.decision === "reject") {
						entry.actions.reject(outcome.feedback);
					} else {
						entry.actions.abort();
					}
				},
			}),
		[interruptLatestAssistantMessage, cancelCompaction, setError]
	);
	sessionRef.current = session;

	return {
		cancelCompaction,
		catalogDiagnostic: state.catalogDiagnostic,
		compact: (
			focus: string | undefined,
			selection: ChatModelSelection,
			selectionVariant?: ModelVariant
		) =>
			runCompaction({
				focus,
				model: selection,
				trigger: "manual",
				...(isUndefined(selectionVariant) ? {} : { variant: selectionVariant }),
			}),
		compactions: state.compactions,
		session,
		error: state.compactionError ?? state.error,
		getCompactionSettings,
		isCompacting: state.isCompacting,
		isPreparingMessage: state.isPreparingMessage,
		messages: state.transcript,
		status: state.status,
		viewState: state.viewState,
		activeMessages: state.context,
	};
}

const summarizeCatalogDiagnostics = (catalog: SkillCatalog): string | null => {
	if (catalog.diagnostics.length === 0) {
		return null;
	}
	const invalidCount = catalog.diagnostics.filter(
		({ code }) => code === "invalid-skill"
	).length;
	const overBudget = catalog.diagnostics.some(
		({ code }) => code === "catalog-over-budget"
	);
	if (invalidCount === 0 && !overBudget) {
		return null;
	}
	const summary: string[] = [];
	if (invalidCount > 0) {
		summary.push(
			`${invalidCount} Skill${invalidCount === 1 ? "" : "s"} omitted (validation limits)`
		);
	}
	if (overBudget) {
		summary.push("Skill tool disabled (catalog over budget)");
	}
	return `Skill catalog: ${summary.join("; ")}`;
};

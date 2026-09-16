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
	type SkillToolDefinition,
} from "@wincode/skills";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentRegistry } from "@/modules/agents";
import { useConnections } from "@/modules/connections";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import {
	createMcpToolExecutor,
	type McpCatalogSnapshot,
	useMcp,
} from "@/modules/mcp";
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
import { createDelegationExecutor } from "./delegation";
import {
	buildAgentTurn,
	buildAssistantCancelledSessionRecord,
	buildAssistantFailureSessionRecord,
	buildTerminalSessionRecord,
	createGatedCodingTools,
	type DelegationExecutor,
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

const waitForCompaction = async (
	operation: Promise<CompactSessionResult> | null
): Promise<string | null> => {
	if (!operation) {
		return null;
	}
	try {
		await operation;
		return null;
	} catch (error) {
		return isBenignCompactionError(error)
			? null
			: getErrorMessage(error, "Session compaction failed.");
	}
};
type RunCompaction = (
	trigger: CompactSessionInput["trigger"],
	focus?: string,
	nextMessages?: readonly SessionMessage[],
	selection?: ChatModelSelection,
	compactionMessages?: readonly SessionMessage[],
	selectionVariant?: ModelVariant
) => Promise<CompactSessionResult>;

type SubmitCompactionResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: string };

const prepareCompactionBeforeSubmit = async ({
	activeMessages,
	compactionModule,
	model,
	runCompaction,
	settings,
}: {
	activeMessages: readonly SessionMessage[];
	compactionModule: SessionCompactionModule;
	model: ChatModelSelection;
	runCompaction: RunCompaction;
	settings: ResolvedCompactionSettings;
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
		await runCompaction("threshold", undefined, undefined, model);
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
			readonly metadata: SessionMessageMetadata;
			readonly resolvedAgent: ResolvedCodingAgent;
			readonly skill?: SkillRequestContext;
	  }
	| { readonly kind: "cancelled" }
	| { readonly kind: "rejected"; readonly reason: string };

type SubmitSkillExecutionFactory = () => Promise<SkillExecution>;
type SubmitSkillResolver = (
	explicitSkillInput: SkillContext | undefined,
	anchoredMessage: SessionMessage | undefined
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
	await createTurnSkillExecution();
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
		anchoredMessage
	);
	if (!skillResolution.ok) {
		return { kind: "rejected", reason: skillResolution.reason };
	}
	return {
		anchoredMessage,
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
			readonly context: Extract<SubmitContextResult, { kind: "ready" }>;
			readonly kind: "ready";
			readonly messages: SessionMessage[];
			readonly newMessage?: SessionMessage;
	  };

const prepareSessionSubmission = async ({
	getActiveMessages,
	compactionModule,
	compactionOperation,
	createTurnSkillExecution,
	getCompactionSettings,
	input,
	runCompaction,
	resolveSkillForSubmit,
	setAttachmentBudget,
	setPreparingMessage,
	signal,
}: {
	getActiveMessages: () => readonly SessionMessage[];
	compactionModule: SessionCompactionModule;
	compactionOperation: Promise<CompactSessionResult> | null;
	createTurnSkillExecution: SubmitSkillExecutionFactory;
	getCompactionSettings: (
		selection: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	input: SessionSendInput;
	runCompaction: RunCompaction;
	resolveSkillForSubmit: SubmitSkillResolver;
	setAttachmentBudget: (
		budget: Pick<
			ResolvedCompactionSettings,
			"maxMediaAttachments" | "maxMediaBytes" | "maxMediaTokens"
		>
	) => void;
	setPreparingMessage: (value: boolean) => void;
	signal: AbortSignal;
}): Promise<SessionPreparationResult> => {
	try {
		const preparationError = await waitForCompaction(compactionOperation);
		if (!isNull(preparationError)) {
			return { kind: "rejected", reason: preparationError };
		}
		const settings = await getCompactionSettings(input.model);
		setAttachmentBudget({
			maxMediaAttachments: settings.maxMediaAttachments,
			maxMediaBytes: settings.maxMediaBytes,
			maxMediaTokens: settings.maxMediaTokens,
		});
		const compactionResult = await prepareCompactionBeforeSubmit({
			activeMessages: getActiveMessages(),
			compactionModule,
			model: input.model,
			runCompaction,
			settings,
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
	assistantId,
	setStatus,
	updateRuntimeMessage,
}: {
	event: AgentTurnEvent;
	assistantId: SessionMessageId | null;
	setStatus: (status: SessionChatStatus) => void;
	updateRuntimeMessage: (
		assistantId: SessionMessageId,
		event: AgentTurnEvent
	) => void;
}): void => {
	if (!isNull(assistantId)) {
		updateRuntimeMessage(assistantId, event);
	}
	if (event.type !== "agent-turn-started") {
		setStatus("streaming");
	}
};

const releaseTurnSnapshot = ({
	mcp,
	mcpSnapshotRef,
	snapshot,
}: {
	mcp: ReturnType<typeof useMcp>;
	mcpSnapshotRef: { current: McpCatalogSnapshot | null };
	snapshot: McpCatalogSnapshot | undefined;
}): void => {
	if (isUndefined(snapshot)) {
		return;
	}
	mcp.releaseSnapshot?.(snapshot);
	if (mcpSnapshotRef.current?.id === snapshot.id) {
		mcpSnapshotRef.current = null;
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
	const childAbortControllersRef = useRef(new Map<ToolCallId, () => void>());
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
					const abortChild = childAbortControllersRef.current.get(
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

	const [engine] = useState(() =>
		createSessionEngine({
			initialCompactions,
			initialContext: initialActiveMessages,
			initialTranscript: initialMessages,
		})
	);
	const {
		applyContext,
		getSnapshot,
		mergeTranscript,
		recordCompaction,
		setCatalogDiagnostic,
		setCompacting,
		setCompactionError,
		setError,
		setPreparingMessage,
		setStatus,
		setViewState,
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
	const compactionAbortRef = useRef<AbortController | null>(null);
	const compactionOperationRef = useRef<Promise<CompactSessionResult> | null>(
		null
	);
	const overflowAttemptRef = useRef(0);
	const requestStartedAtRef = useRef<number | null>(null);
	const currentAssistantIdRef = useRef<SessionMessageId | null>(null);
	const currentSourceUserMessageIdRef = useRef<SessionMessageId | null>(null);
	const agentRef = useRef<AgentId>(buildAgent.id);
	const resolvedAgentRef = useRef<ResolvedCodingAgent | undefined>(undefined);
	const modelRef = useRef<ChatModelSelection>(defaultChatModelSelection);
	const sessionModelRef = useRef<ChatModelSelection>(defaultChatModelSelection);
	const sessionVariantRef = useRef<ModelVariant | undefined>(undefined);
	const variantRef = useRef<ModelVariant | undefined>(undefined);
	const attachmentBudgetRef = useRef<
		| Pick<
				AttachmentHydrationOptions,
				"maxAttachments" | "maxBytes" | "maxTokens"
		  >
		| undefined
	>(undefined);
	const mcpSnapshotRef = useRef<McpCatalogSnapshot | null>(null);
	const skillExecutionRef = useRef<SkillExecution | null>(null);
	const skillToolRef = useRef<SkillToolDefinition | undefined>(undefined);
	const sessionRef = useRef<SessionOperation | null>(null);
	const providerErrorRef = useRef<(error: unknown) => void>(() => undefined);

	const estimateRuntimeRequestOverheadTokens = useCallback((): number => {
		const resolvedAgent = resolvedAgentRef.current;
		const codingTools =
			resolvedAgent?.visibleCodingTools.map((name) => {
				const definition = codingToolDefinitions[name];
				return { description: definition.description, name };
			}) ?? [];
		const skillTool = skillToolRef.current;
		const serializedContext = JSON.stringify({
			agentInstructions: resolvedAgent?.instructions ?? "",
			codingTools,
			mcpTools: mcpSnapshotRef.current?.manifest ?? [],
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
		(selection: ChatModelSelection = modelRef.current) =>
			getSettingsForModel(selection),
		[getSettingsForModel]
	);
	const runCompaction = useCallback(
		(
			trigger: CompactSessionInput["trigger"],
			focus?: string,
			nextMessages?: readonly SessionMessage[],
			selection?: ChatModelSelection,
			compactionMessages?: readonly SessionMessage[],
			selectionVariant?: ModelVariant
		): Promise<CompactSessionResult> => {
			const current = compactionOperationRef.current;
			if (current) {
				return current;
			}
			const compactionModel = selection ?? modelRef.current;
			const compactionVariant = selectionVariant ?? variantRef.current;
			const controller = new AbortController();
			compactionAbortRef.current = controller;
			const operation = (async () => {
				setCompacting(true);
				const transcriptMessages = nextMessages
					? mergeTranscript(nextMessages)
					: getSnapshot().transcript;
				const sessionMessages = compactionMessages
					? [...compactionMessages]
					: transcriptMessages;
				const settings = await getCompactionSettings(compactionModel);
				const result = await compactionModule.compact({
					session: { messages: sessionMessages, sessionId },
					focus,
					model: compactionModel,
					...(isUndefined(compactionVariant)
						? {}
						: { variant: compactionVariant }),
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
					signal: controller.signal,
					trigger,
				});
				setCompactionError(null);
				applyContext(result.activeMessages);
				recordCompaction(result.entry);
				return result;
			})().finally(() => {
				if (compactionOperationRef.current === operation) {
					compactionOperationRef.current = null;
				}
				compactionAbortRef.current = null;
				setCompacting(false);
			});
			compactionOperationRef.current = operation;
			return operation;
		},
		[
			compactionModule,
			estimateRuntimeRequestOverheadTokens,
			getCompactionSettings,
			mergeTranscript,
			applyContext,
			sessionId,
			setCompactionError,
			recordCompaction,
			getSnapshot,
			setCompacting,
		]
	);
	const cancelCompaction = useCallback(() => {
		compactionAbortRef.current?.abort();
	}, []);
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
					await runCompaction(
						"threshold",
						undefined,
						messages,
						selection,
						undefined,
						variant
					);
				} catch (error) {
					if (!isBenignCompactionError(error)) {
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
		useCallback(async (): Promise<SkillExecution> => {
			const permission = await resolvePermission();
			const catalog = await discoverSkillCatalog(config, (name) =>
				permission.decide("skill", name)
			);
			const execution = createSkillExecution(catalog);
			skillExecutionRef.current = execution;
			skillToolRef.current = buildSkillToolDefinition(catalog);
			setCatalogDiagnostic(summarizeCatalogDiagnostics(catalog));
			return execution;
		}, [config, resolvePermission, setCatalogDiagnostic]);

	const resolveSkillForSubmit = useCallback(
		async (
			explicitSkillInput: SkillContext | undefined,
			anchoredMessage: SessionMessage | undefined
		): Promise<
			| { ok: true; skill: SkillRequestContext | undefined }
			| { ok: false; reason: string }
		> => {
			const execution = skillExecutionRef.current;
			if (!isUndefined(explicitSkillInput)) {
				if (isNull(execution)) {
					return { ok: false, reason: "Skill catalog is unavailable" };
				}
				return activateExplicitSkill(explicitSkillInput, {
					execution,
					gate: toolGateState.gate,
				});
			}
			if (isUndefined(anchoredMessage) || isNull(execution)) {
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
		(assistantId: SessionMessageId, event: AgentTurnEvent): void => {
			const current = getSnapshot().context;
			const index = current.findIndex(({ id }) => id === assistantId);
			const existing: SessionMessage =
				index === -1
					? createEmptyRuntimeAssistantMessage(
							assistantId,
							currentSourceUserMessageIdRef.current,
							agentRef.current,
							modelRef.current
						)
					: (current[index] ??
						createEmptyRuntimeAssistantMessage(
							assistantId,
							currentSourceUserMessageIdRef.current,
							agentRef.current,
							modelRef.current
						));
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
		(assistantId: SessionMessageId, event: AgentTurnTerminalEvent): void => {
			const current = getSnapshot().context;
			const index = current.findIndex(({ id }) => id === assistantId);
			const base =
				index === -1
					? createEmptyRuntimeAssistantMessage(
							assistantId,
							currentSourceUserMessageIdRef.current,
							agentRef.current,
							modelRef.current
						)
					: current[index];
			if (isUndefined(base)) {
				return;
			}
			const startedAt = requestStartedAtRef.current;
			const usage =
				event.type === "agent-turn-completed"
					? normalizeModelUsage(event.usage)
					: null;
			const metadata = buildTerminalMessageMetadata({
				agent: agentRef.current,
				base,
				event,
				model: modelRef.current,
				startedAt,
				usage,
				variant: variantRef.current,
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
				assistantId,
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
			agent,
			delegation,
			model,
			resolvedAgent,
			skill,
			sourceUserMessageId,
			variant,
			modelMessages,
			signal,
		}: {
			agent: AgentId;
			delegation?: AgentTurnDelegation;
			model: ChatModelSelection;
			resolvedAgent: ResolvedCodingAgent;
			skill?: SkillRequestContext;
			sourceUserMessageId?: SessionMessageId;
			variant?: ModelVariant;
			modelMessages: readonly SessionMessage[];
			signal: AbortSignal;
		}): Promise<SessionSendOutcome> => {
			setError(null);
			setViewState(undefined);
			setStatus("submitted");
			const store = getSessionStore();
			const turnId = createAgentTurnId();
			currentAssistantIdRef.current = toSessionMessageId(`assistant-${turnId}`);
			currentSourceUserMessageIdRef.current = sourceUserMessageId ?? null;
			let snapshot: McpCatalogSnapshot | undefined;
			let executionStarted = false;
			let currentTurn: AgentTurn | undefined;
			let terminalObserved = false;
			const commitRecord = (record: SessionRecord) =>
				store.commitSessionRecord({
					...(isUndefined(delegation)
						? {
								sessionModel: sessionModelRef.current,
								sessionVariant: sessionVariantRef.current,
							}
						: {}),
					record,
					sessionId,
				});
			try {
				const modelTarget = await resolveChatModelTarget(model, connections, {
					signal,
					...(isUndefined(variant) ? {} : { variant }),
				});
				const mcpPolicy = await resolveMcpPolicyForAgentRef.current(agent);
				snapshot = await mcp.createSnapshot(agent, mcpPolicy);
				mcpSnapshotRef.current = snapshot;
				const hydratedMessages = await store.hydrateAttachments(modelMessages, {
					purpose: "model",
					priorityMessageId: modelMessages.findLast(
						({ role }) => role === "user"
					)?.id,
					signal,
					...(attachmentBudgetRef.current ?? {}),
				});
				const executeMcpTool = createMcpToolExecutor(mcp.execute);
				const gatedTooling: RuntimeGatedTooling = {
					gate: toolGateState.gate,
					mcpSnapshot: snapshot,
					executeMcpTool,
					registerChildAbort: (toolCallId, abort) => {
						childAbortControllersRef.current.set(toolCallId, abort);
						return () => childAbortControllersRef.current.delete(toolCallId);
					},
					resolveResourceLimits: (agentId) =>
						isUndefined(agentId)
							? resolveResourceLimitsRef.current()
							: resolveResourceLimitsForAgentRef.current(agentId),
				};
				const tools = createGatedCodingTools({
					agentId: agent,
					agentTools: resolvedAgent.visibleCodingTools,
					delegate:
						registryRef.current?.agents.some(
							({ isAvailable, role }) =>
								isAvailable && (role === "subagent" || role === "all")
						) === true
							? runtimeGatedToolingRef.current.delegate
							: undefined,
					executeMcpTool,
					gate: gatedTooling.gate,
					mcpSnapshot: snapshot,
					parentTurnId: turnId,
					resolveResourceLimits: gatedTooling.resolveResourceLimits,
					skillExecution: skillExecutionRef.current ?? undefined,
					skillTool: skillToolRef.current,
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
					skill,
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
							assistantId: currentAssistantIdRef.current,
							event,
							setStatus,
							updateRuntimeMessage,
						});
					},
					sourceUserMessageId,
					onTerminal: (event) => {
						executionStarted = true;
						terminalObserved = true;
						if (!isNull(currentAssistantIdRef.current)) {
							finalizeRuntimeMessage(currentAssistantIdRef.current, event);
						}
					},
					onToolCheckpoint: commitRecord,
					onViewState: setViewState,
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
					onProviderError: providerErrorRef.current,
					applyContext,
					setError,
					signal,
					terminalObserved,
					turnId,
					variant,
					sourceUserMessageId,
				});
			} finally {
				releaseTurnSnapshot({
					mcp,
					mcpSnapshotRef,
					snapshot,
				});
				currentAssistantIdRef.current = null;
				currentSourceUserMessageIdRef.current = null;
			}
		},
		[
			connections,
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

	const runtimeGatedToolingRef = useLatest<RuntimeGatedTooling>({
		delegate: (request, signal) => {
			const execute = delegationExecutorRef.current;
			return isUndefined(execute)
				? Promise.reject(new Error("Delegation is unavailable."))
				: execute(request, signal);
		},
		gate: toolGateState.gate,
		resolveResourceLimits: (agentId) =>
			isUndefined(agentId)
				? resolveResourceLimitsRef.current()
				: resolveResourceLimitsForAgentRef.current(agentId),
	});
	const delegationExecutorRef = useRef<DelegationExecutor | undefined>(
		undefined
	);
	delegationExecutorRef.current = createDelegationExecutor({
		connections,
		createSkillContext: async (agent) => {
			const permission = await resolvePermissionForAgentRef.current(agent);
			const catalog = await discoverSkillCatalog(config, (name) =>
				permission.decide("skill", name)
			);
			const execution = createSkillExecution(catalog);
			const tool = buildSkillToolDefinition(catalog);
			return isUndefined(tool) ? undefined : { execution, tool };
		},
		cwd: config.cwd,
		fallbackModelRef: modelRef,
		fallbackVariantRef: variantRef,
		gatedTooling: runtimeGatedToolingRef.current,
		mcp,
		resolveMcpPolicyForAgent: (agent) =>
			resolveMcpPolicyForAgentRef.current(agent),
		resolvePermissionForAgent: (agent) =>
			resolvePermissionForAgentRef.current(agent),
		onViewState: setViewState,
		registry,
		sessionId,
		workspace: config.workspace,
	});

	const submit = useCallback(
		async (
			input: SessionSendInput,
			signal: AbortSignal
		): Promise<SessionSendOutcome> => {
			setCompactionError(null);
			approvalAbortHandledRef.current = false;
			overflowAttemptRef.current = 0;
			agentRef.current = input.agent;
			resolvedAgentRef.current = input.resolvedAgent;
			sessionModelRef.current = input.sessionModel;
			sessionVariantRef.current = input.sessionVariant;
			modelRef.current = input.model;
			variantRef.current = input.variant;
			requestStartedAtRef.current = Date.now();

			const prepared = await prepareSessionSubmission({
				getActiveMessages: () => getSnapshot().context,
				compactionModule,
				compactionOperation: compactionOperationRef.current,
				createTurnSkillExecution,
				getCompactionSettings,
				input,
				runCompaction,
				resolveSkillForSubmit,
				setAttachmentBudget: ({
					maxMediaAttachments,
					maxMediaBytes,
					maxMediaTokens,
				}) => {
					attachmentBudgetRef.current = {
						maxAttachments: maxMediaAttachments,
						maxBytes: maxMediaBytes,
						maxTokens: maxMediaTokens,
					};
				},
				setPreparingMessage,
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
				const userRecord = buildUserSessionRecord({
					agentId: input.agent,
					message: prepared.newMessage,
					model: input.model,
					turnId: createAgentTurnId(),
					variant: input.variant,
				});
				try {
					await getSessionStore().commitSessionRecord({
						sessionModel: input.sessionModel,
						sessionVariant: input.sessionVariant,
						record: userRecord,
						sessionId,
					});
				} catch (error) {
					const safeError = isError(error)
						? error
						: new Error("Could not save the prompt.");
					setError(safeError);
					return {
						rejected: true,
						reason: "Could not save the prompt.",
					};
				}
			}
			applyContext(modelMessages);
			mergeTranscript(modelMessages);
			return runTurn({
				agent: input.agent,
				delegation: input.delegation,
				model: input.model,
				modelMessages,
				resolvedAgent: readyContext.resolvedAgent,
				signal,
				sourceUserMessageId:
					readyContext.anchoredMessage?.id ?? prepared.newMessage?.id,
				skill: readyContext.skill,
				variant: input.variant,
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
			getSnapshot,
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
			const startedAt = requestStartedAtRef.current;
			const finalized = finalizeAssistantMessageMetadata(target, {
				agent: agentRef.current,
				interrupted: true,
				model: modelRef.current,
				variant: variantRef.current,
				...(isNull(startedAt)
					? {}
					: { responseTimeMs: Math.max(0, Date.now() - startedAt) }),
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

	providerErrorRef.current = (providerError) => {
		if (
			overflowAttemptRef.current > 0 ||
			!isModelContextOverflowError(providerError)
		) {
			return;
		}
		overflowAttemptRef.current = 1;
		const failedModel = modelRef.current;
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
						runCompaction(
							"overflow",
							undefined,
							undefined,
							input.model,
							input.session.messages,
							variantRef.current
						),
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
					replay: async ({ activeMessages, entry, originalMessageId }) => {
						applyContext(activeMessages);
						recordCompaction(entry);
						const operation = sessionRef.current;
						if (isNull(operation) || !(await operation.waitForIdle())) {
							return;
						}
						const outcome = await operation.send({
							agent: agentRef.current,
							sessionModel: sessionModelRef.current,
							sessionVariant: sessionVariantRef.current,
							messageId: originalMessageId,
							model: failedModel,
							resolvedAgent: resolvedAgentRef.current,
							variant: variantRef.current,
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
						compactionAbortRef.current?.abort();
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
		[interruptLatestAssistantMessage, setError]
	);
	sessionRef.current = session;

	return {
		cancelCompaction,
		catalogDiagnostic: state.catalogDiagnostic,
		compact: (
			focus?: string,
			selection?: ChatModelSelection,
			selectionVariant?: ModelVariant
		) =>
			runCompaction(
				"manual",
				focus,
				undefined,
				selection,
				undefined,
				selectionVariant
			),
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

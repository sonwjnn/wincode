import {
	type AgentId,
	type AgentTurn,
	type AgentTurnDelegation,
	type AgentTurnEvent,
	type AgentTurnTerminalEvent,
	type ConversationRecord,
	createAgentTurnAbortEvent,
	createAgentTurnId,
	getAgentTurnAbortDisposition,
} from "@wincode/agent-core";
import { normalizeModelUsage } from "@wincode/ai/model-usage";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { defaultChatModelSelection } from "@wincode/ai/models";
import {
	type CodingToolName,
	codingToolDefinitions,
	codingToolNames,
} from "@wincode/coding-tools";
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
	sanitizeSkillToolPart,
} from "@wincode/skills";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentRegistry } from "@/modules/agents";
import { useConnections } from "@/modules/connections";
import {
	COMPACTION_REQUEST_OVERHEAD_TOKENS,
	type CompactConversationInput,
	type CompactConversationResult,
	type ConversationCompaction,
	ConversationCompactionError,
	type ConversationCompactionModule,
	createConversationCompaction,
	createDirectSummaryGenerator,
	estimateCompactionTokens,
	isCompactionSummaryMessage,
	isModelContextOverflowError,
	type ResolvedCompactionSettings,
	recoverContextOverflow,
	useCompactionSettings,
} from "@/modules/conversations/compaction";
import {
	type ConversationMessage,
	type ConversationMessageMetadata,
	type ConversationMessageTerminalOutcome,
	type ConversationPart,
	type ConversationToolPart,
	conversationMessageSkillSchema,
	createConversationUserMessage,
	isConversationToolPart,
	isTerminalConversationToolPart,
	sanitizeInterruptedConversationMessages,
} from "@/modules/conversations/message";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import {
	createMcpToolExecutor,
	type McpCatalogSnapshot,
	useMcp,
} from "@/modules/mcp";
import { useToolPermission } from "@/modules/permissions";
import { discoverSkillCatalog } from "@/modules/skills";
import { createToolGate, type ToolGate } from "@/modules/tool-gate/tool-gate";
import { useConfig } from "@/shared/config/config-provider";
import { useLatest } from "@/shared/hooks/use-latest";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type { ResolvedCodingAgent } from "../../agents/built-ins";
import { resolveChatModelTarget } from "../../model-target";
import type { ConversationViewState } from "../conversation-controller";
import { createConversationController } from "../conversation-controller";
import type {
	ConversationOperation,
	ConversationSendInput,
	ConversationSendOutcome,
} from "../conversation-operation";
import type { ConversationFilePart } from "../message";
import type { AttachmentHydrationOptions } from "../storage/attachment-store";
import { buildUserConversationRecord } from "../storage/conversation-record";
import { getConversationStore } from "../storage/get-conversation-store";
import { createDelegationExecutor } from "./delegation";
import {
	buildAgentTurn,
	buildAssistantCancelledConversationRecord,
	buildAssistantFailureConversationRecord,
	buildTerminalConversationRecord,
	createGatedCodingTools,
	type DelegationExecutor,
	defaultRuntimeFactory,
	type RuntimeGatedTooling,
	runAgentTurnToText,
} from "./runtime-turn";

export type ConversationChatStatus = "ready" | "streaming" | "submitted";

export const createChatMessageParts = (
	userText: string,
	fileMentions: ConversationPart[],
	files: ConversationFilePart[]
): ConversationPart[] => [
	{ text: userText, type: "text" },
	...fileMentions,
	...files,
];

const AGENT_TURN_DEADLINE_MS = 43_200_000;
const INTERRUPTED_TOOL_ERROR = "Tool call interrupted";

const isBenignCompactionError = (error: unknown): boolean =>
	error instanceof ConversationCompactionError &&
	(error.code === "history-too-short" || error.code === "not-needed");

const compactionErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "Conversation compaction failed.";

const waitForCompaction = async (
	operation: Promise<CompactConversationResult> | null
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
			: compactionErrorMessage(error);
	}
};
type RunCompaction = (
	trigger: CompactConversationInput["trigger"],
	focus?: string,
	nextMessages?: readonly ConversationMessage[],
	selection?: ChatModelSelection,
	compactionMessages?: readonly ConversationMessage[],
	selectionVariant?: ModelVariant
) => Promise<CompactConversationResult>;

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
	activeMessages: readonly ConversationMessage[];
	compactionModule: ConversationCompactionModule;
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
			return { ok: false, reason: compactionErrorMessage(cause) };
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
			readonly anchoredMessage?: ConversationMessage;
			readonly metadata: ConversationMessageMetadata;
			readonly resolvedAgent: ResolvedCodingAgent;
			readonly skill?: SkillRequestContext;
	  }
	| { readonly kind: "cancelled" }
	| { readonly kind: "rejected"; readonly reason: string };

type SubmitSkillExecutionFactory = () => Promise<SkillExecution>;
type SubmitSkillResolver = (
	explicitSkillInput: SkillContext | undefined,
	anchoredMessage: ConversationMessage | undefined
) => Promise<SubmitSkillResolution>;

const createSubmitMetadata = (
	input: ConversationSendInput,
	skill: SkillRequestContext | undefined
): ConversationMessageMetadata => ({
	agent: input.agent,
	model: input.model,
	...(input.variant === undefined ? {} : { variant: input.variant }),
	...(skill === undefined
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
	activeMessages: readonly ConversationMessage[];
	createTurnSkillExecution: SubmitSkillExecutionFactory;
	input: ConversationSendInput;
	resolveSkillForSubmit: SubmitSkillResolver;
	signal: AbortSignal;
}): Promise<SubmitContextResult> => {
	await createTurnSkillExecution();
	if (signal.aborted) {
		return { kind: "cancelled" };
	}
	const resolvedAgent = input.resolvedAgent;
	if (resolvedAgent === undefined) {
		return {
			kind: "rejected",
			reason: "The resolved Agent is unavailable.",
		};
	}
	const anchoredMessage =
		input.messageId === undefined
			? undefined
			: activeMessages.find(({ id }) => id === input.messageId);
	if (input.messageId !== undefined && anchoredMessage?.role !== "user") {
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

type NewConversationMessageResult =
	| { readonly kind: "ready"; readonly message: ConversationMessage }
	| { readonly kind: "cancelled" }
	| { readonly kind: "rejected"; readonly reason: string };

const prepareNewConversationMessage = async ({
	input,
	metadata,
	signal,
}: {
	input: ConversationSendInput;
	metadata: ConversationMessageMetadata;
	signal: AbortSignal;
}): Promise<NewConversationMessageResult> => {
	const userText = input.userText;
	if (userText === undefined) {
		return { kind: "rejected", reason: "No prompt to submit" };
	}
	const fileMentions = await resolveFileMentionParts(userText);
	const optimistic = createConversationUserMessage(
		userText,
		metadata,
		fileMentions,
		input.files ?? []
	);
	try {
		const [externalized] = await getConversationStore().externalizeAttachments(
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

const conversationSendCancelled = (
	signal?: AbortSignal
): ConversationSendOutcome => {
	if (signal === undefined) {
		return { rejected: true, reason: "Conversation send cancelled." };
	}
	switch (getAgentTurnAbortDisposition(signal.reason)) {
		case "cancelled":
			return { rejected: true, reason: "Conversation send cancelled." };
		case "deadline-exceeded":
			return {
				rejected: true,
				reason: "Conversation send deadline exceeded.",
			};
		case "interrupted":
			return { rejected: true, reason: "Conversation turn interrupted." };
		default:
			return { rejected: true, reason: "Conversation send cancelled." };
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
}): ConversationSendOutcome => {
	if (signal.aborted) {
		return executionStarted
			? { rejected: false }
			: conversationSendCancelled(signal);
	}
	const normalizedError =
		error instanceof Error ? error : new Error("The Agent Turn failed.");
	setError(normalizedError);
	if (!executionStarted) {
		return { rejected: true, reason: normalizedError.message };
	}
	onProviderError(error);
	return { rejected: false };
};

export const sanitizeSkillToolParts = (
	messages: ConversationMessage[]
): ConversationMessage[] =>
	messages.map((message) =>
		message.parts.some(isSkillToolPart)
			? {
					...message,
					parts: message.parts.map((part) =>
						isSkillToolPart(part) ? sanitizeSkillToolPart(part) : part
					),
				}
			: message
	);

type PreparedModelMessages =
	| { readonly kind: "cancelled" }
	| {
			readonly kind: "ready";
			readonly messages: ConversationMessage[];
			readonly newMessage?: ConversationMessage;
	  }
	| { readonly kind: "rejected"; readonly reason: string };

const hasCompletedToolArtifact = (
	messages: readonly ConversationMessage[],
	startIndex: number
): boolean => {
	const nextUserIndex = messages.findIndex(
		(message, index) => index > startIndex && message.role === "user"
	);
	const attemptMessages = messages.slice(
		startIndex + 1,
		nextUserIndex === -1 ? undefined : nextUserIndex
	);
	return attemptMessages.some(
		(message) =>
			message.role === "assistant" &&
			message.parts.some(
				(part) =>
					isConversationToolPart(part) && isTerminalConversationToolPart(part)
			)
	);
};
export const prepareRetryMessages = (
	messages: readonly ConversationMessage[],
	messageId: string
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
	if (hasCompletedToolArtifact(messages, messageIndex)) {
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
						message.metadata?.terminalOutcome === undefined)
			)
		),
	};
};

const prepareModelMessages = async ({
	activeMessages,
	context,
	input,
	setIsPreparingMessage,
	signal,
}: {
	activeMessages: readonly ConversationMessage[];
	context: Extract<SubmitContextResult, { kind: "ready" }>;
	input: ConversationSendInput;
	setIsPreparingMessage: (value: boolean) => void;
	signal: AbortSignal;
}): Promise<PreparedModelMessages> => {
	if (context.anchoredMessage !== undefined && input.messageId !== undefined) {
		return prepareRetryMessages(activeMessages, input.messageId);
	}

	setIsPreparingMessage(true);
	try {
		const preparedMessage = await prepareNewConversationMessage({
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
		setIsPreparingMessage(false);
	}
};
type ConversationPreparationResult =
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
			readonly messages: ConversationMessage[];
			readonly newMessage?: ConversationMessage;
	  };

const prepareConversationSubmission = async ({
	getActiveMessages,
	compactionModule,
	compactionOperation,
	createTurnSkillExecution,
	getCompactionSettings,
	input,
	runCompaction,
	resolveSkillForSubmit,
	setAttachmentBudget,
	setIsPreparingMessage,
	signal,
}: {
	getActiveMessages: () => readonly ConversationMessage[];
	compactionModule: ConversationCompactionModule;
	compactionOperation: Promise<CompactConversationResult> | null;
	createTurnSkillExecution: SubmitSkillExecutionFactory;
	getCompactionSettings: (
		selection: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	input: ConversationSendInput;
	runCompaction: RunCompaction;
	resolveSkillForSubmit: SubmitSkillResolver;
	setAttachmentBudget: (
		budget: Pick<
			ResolvedCompactionSettings,
			"maxMediaAttachments" | "maxMediaBytes" | "maxMediaTokens"
		>
	) => void;
	setIsPreparingMessage: (value: boolean) => void;
	signal: AbortSignal;
}): Promise<ConversationPreparationResult> => {
	try {
		const preparationError = await waitForCompaction(compactionOperation);
		if (preparationError !== null) {
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
			setIsPreparingMessage,
			signal,
		});
		if (prepared.kind !== "ready") {
			return prepared;
		}
		return {
			context,
			kind: "ready",
			messages: prepared.messages,
			...(prepared.newMessage === undefined
				? {}
				: { newMessage: prepared.newMessage }),
		};
	} catch (error) {
		if (signal.aborted) {
			return { kind: "cancelled" };
		}
		const normalizedError =
			error instanceof Error
				? error
				: new Error("Conversation preparation failed.");
		return {
			error: normalizedError,
			kind: "rejected",
			reason: normalizedError.message,
		};
	}
};
const conversationOutcomeForPreparation = (
	result: Extract<
		SubmitContextResult | PreparedModelMessages,
		{ kind: "cancelled" | "rejected" }
	>,
	signal: AbortSignal
): ConversationSendOutcome =>
	result.kind === "cancelled"
		? conversationSendCancelled(signal)
		: { rejected: true, reason: result.reason };

const handleSafeAssistantOutcome = async ({
	agent,
	currentMessages,
	mergeDisplayMessages,
	model,
	publishActiveMessages,
	record,
	setError,
	turnId,
	variant,
	commitRecord,
}: {
	agent: AgentId;
	currentMessages: readonly ConversationMessage[];
	mergeDisplayMessages: (messages: readonly ConversationMessage[]) => void;
	model: ChatModelSelection;
	publishActiveMessages: (messages: ConversationMessage[]) => void;
	record: ConversationRecord;
	setError: (error: Error) => void;
	turnId: string;
	variant?: ModelVariant;
	commitRecord: (record: ConversationRecord) => Promise<void>;
}): Promise<ConversationSendOutcome> => {
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
	const failureMessage: ConversationMessage = {
		id: durableMessage?.id ?? `assistant-${turnId}`,
		metadata: {
			agent,
			model,
			...(terminal === "interrupted" ? { interrupted: true } : {}),
			...(terminal === "completed" ? {} : { terminalOutcome: terminal }),
			...(variant === undefined ? {} : { variant }),
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
	publishActiveMessages(nextMessages);
	mergeDisplayMessages([failureMessage]);
	return { rejected: false };
};

const handlePreExecutionTurnFailure = async ({
	agent,
	delegation,
	error,
	model,
	turnId,
	variant,
	commitRecord,
	currentMessages,
	mergeDisplayMessages,
	publishActiveMessages,
	setError,
}: {
	agent: AgentId;
	delegation?: AgentTurnDelegation;
	error: unknown;
	model: ChatModelSelection;
	turnId: string;
	variant?: ModelVariant;
	commitRecord: (record: ConversationRecord) => Promise<void>;
	currentMessages: readonly ConversationMessage[];
	mergeDisplayMessages: (messages: readonly ConversationMessage[]) => void;
	publishActiveMessages: (messages: ConversationMessage[]) => void;
	setError: (error: Error) => void;
}): Promise<ConversationSendOutcome> =>
	handleSafeAssistantOutcome({
		agent,
		commitRecord,
		currentMessages,
		mergeDisplayMessages,
		model,
		publishActiveMessages,
		record: buildAssistantFailureConversationRecord({
			agentId: agent,
			delegation,
			error,
			model,
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
	mergeDisplayMessages,
	model,
	publishActiveMessages,
	setError,
	signal,
	terminalObserved,
	turnId,
	variant,
	onProviderError,
	commitRecord,
}: {
	agent: AgentId;
	currentMessages: readonly ConversationMessage[];
	currentTurn?: AgentTurn;
	delegation?: AgentTurnDelegation;
	error: unknown;
	executionStarted: boolean;
	mergeDisplayMessages: (messages: readonly ConversationMessage[]) => void;
	model: ChatModelSelection;
	onProviderError: (error: unknown) => void;
	publishActiveMessages: (messages: ConversationMessage[]) => void;
	setError: (error: Error) => void;
	signal: AbortSignal;
	terminalObserved: boolean;
	turnId: string;
	variant?: ModelVariant;
	commitRecord: (record: ConversationRecord) => Promise<void>;
}): Promise<ConversationSendOutcome> => {
	if (!executionStarted) {
		if (signal.aborted) {
			return handleSafeAssistantOutcome({
				agent,
				commitRecord,
				currentMessages,
				mergeDisplayMessages,
				model,
				publishActiveMessages,
				record: buildAssistantCancelledConversationRecord({
					agentId: agent,
					delegation,
					model,
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
			mergeDisplayMessages,
			model,
			publishActiveMessages,
			setError,
			turnId,
			variant,
		});
	}
	if (!terminalObserved && currentTurn !== undefined) {
		const fallbackRecord = signal.aborted
			? buildTerminalConversationRecord({
					assistantText: "",
					event: createAgentTurnAbortEvent(currentTurn, signal, 0),
					turn: currentTurn,
				})
			: buildAssistantFailureConversationRecord({
					agentId: agent,
					delegation,
					error,
					model,
					turnId,
					variant,
				});
		if (fallbackRecord !== undefined) {
			return handleSafeAssistantOutcome({
				agent,
				commitRecord,
				currentMessages,
				mergeDisplayMessages,
				model,
				publishActiveMessages,
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
	assistantId: string | null;
	setStatus: (status: ConversationChatStatus) => void;
	updateRuntimeMessage: (assistantId: string, event: AgentTurnEvent) => void;
}): void => {
	if (assistantId !== null) {
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
	if (snapshot === undefined) {
		return;
	}
	mcp.releaseSnapshot?.(snapshot);
	if (mcpSnapshotRef.current?.id === snapshot.id) {
		mcpSnapshotRef.current = null;
	}
};

export const findCurrentTurnAssistantIndex = (
	messages: ConversationMessage[]
): number => {
	const userIndex = messages.findLastIndex(({ role }) => role === "user");
	const assistantIndex = messages.findLastIndex(
		({ role }) => role === "assistant"
	);
	return assistantIndex > userIndex ? assistantIndex : -1;
};

const preserveInterruptedToolCall = (
	message: ConversationMessage,
	toolCallId: string
): ConversationMessage => {
	if (message.role !== "assistant" || message.metadata?.interrupted !== true) {
		return message;
	}
	return {
		...message,
		parts: message.parts.map((part) =>
			isConversationToolPart(part) &&
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

export const sanitizeInterruptedMessagesForConversation = (
	messages: ConversationMessage[],
	preserveToolCallId?: string
): ConversationMessage[] =>
	sanitizeInterruptedConversationMessages(
		messages.map((message) =>
			preserveToolCallId === undefined
				? message
				: preserveInterruptedToolCall(message, preserveToolCallId)
		),
		preserveToolCallId
	);

export const findCurrentTurnInterruptTargetIndex = (
	messages: ConversationMessage[]
): number => {
	const assistantIndex = findCurrentTurnAssistantIndex(messages);
	return assistantIndex === -1
		? messages.findLastIndex(({ role }) => role === "user")
		: assistantIndex;
};

export const finalizeAssistantMessageMetadata = (
	message: ConversationMessage,
	context: {
		agent: AgentId;
		model: ChatModelSelection;
		variant?: ModelVariant;
		interrupted: boolean;
		responseTimeMs?: number;
	}
): ConversationMessage => {
	const variant = message.metadata?.variant ?? context.variant;
	const metadata: ConversationMessageMetadata = {
		...(message.metadata ?? {}),
		agent: message.metadata?.agent ?? context.agent,
		interrupted: context.interrupted,
		model: message.metadata?.model ?? context.model,
		...(variant === undefined ? {} : { variant }),
		...(context.responseTimeMs === undefined
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
		available: entry !== undefined,
		description: entry?.description ?? `Activate Skill ${skill.name}`,
		family: "skill",
		name: skill.name,
	});
	if (policyOutcome.kind !== "allow") {
		execution.markRejected(skill.name);
		return { ok: false, reason: policyOutcome.errorText };
	}
	if (entry === undefined) {
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
	part: ConversationToolPart,
	event: RuntimeToolFinishedEvent
): ConversationToolPart =>
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
): ConversationToolPart =>
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
): ConversationMessageTerminalOutcome | undefined => {
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

const sanitizeFailedRuntimeMessages = (
	messages: readonly ConversationMessage[],
	assistantId: string,
	failureText: string
): ConversationMessage[] =>
	messages.map((message) => {
		if (message.id !== assistantId || message.role !== "assistant") {
			return message;
		}
		const terminalToolParts = message.parts.filter(
			(part): part is ConversationToolPart =>
				isConversationToolPart(part) && isTerminalConversationToolPart(part)
		);
		return {
			...message,
			parts: [{ text: failureText, type: "text" }, ...terminalToolParts],
		};
	});

const sanitizeRuntimeMessagesForTerminal = (
	messages: readonly ConversationMessage[],
	assistantId: string,
	event: AgentTurnTerminalEvent
): ConversationMessage[] => {
	if (event.type === "agent-turn-completed") {
		return [...messages];
	}
	if (event.type === "agent-turn-interrupted") {
		return sanitizeInterruptedConversationMessages(messages);
	}
	return sanitizeFailedRuntimeMessages(
		messages,
		assistantId,
		event.failure.message
	);
};
export function useChat(
	sessionId: string,
	initialMessages: ConversationMessage[],
	initialActiveMessages: ConversationMessage[] = initialMessages,
	initialCompactions: ConversationCompaction[] = []
) {
	const connections = useConnections();
	const mcp = useMcp();
	const config = useConfig();
	const { getCompactionSettings: getSettingsForModel } =
		useCompactionSettings();
	const registry = useAgentRegistry();
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
	const childAbortControllersRef = useRef(new Map<string, () => void>());
	const approvalAbortHandledRef = useRef(false);
	const abortApprovalTurnRef = useRef<(toolCallId: string) => void>(
		() => undefined
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: latest-value refs intentionally keep tool gate callbacks current without rebuilding the gate.
	const toolGateState = useMemo(() => {
		const approvalQueue = createApprovalQueue<ToolApprovalRequest>();
		return {
			approvalQueue,
			gate: createToolGate({
				approvalQueue,
				onAbort: (request) => {
					if (request.toolCallId === undefined) {
						return;
					}
					const abortChild = childAbortControllersRef.current.get(
						request.toolCallId
					);
					if (abortChild !== undefined) {
						abortChild();
						return;
					}
					abortApprovalTurnRef.current(request.toolCallId);
				},
				openApproval,
				resolvePermission: (agentId) =>
					agentId === undefined
						? resolvePermissionRef.current()
						: resolvePermissionForAgentRef.current(agentId),
				resolveResourceLimits: (agentId) =>
					agentId === undefined
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

	const displayMessagesRef = useRef<ConversationMessage[]>([
		...initialMessages,
	]);
	const activeMessagesRef = useRef<ConversationMessage[]>([
		...initialActiveMessages,
	]);
	const [displayMessages, setDisplayMessages] = useState<ConversationMessage[]>(
		() => [...initialMessages]
	);
	const [activeMessages, setActiveMessages] = useState<ConversationMessage[]>(
		() => [...initialActiveMessages]
	);
	const [status, setStatus] = useState<ConversationChatStatus>("ready");
	const [error, setError] = useState<Error | null>(null);
	const [viewState, setViewState] = useState<ConversationViewState>();
	const [compactions, setCompactions] = useState<ConversationCompaction[]>(
		() => [...initialCompactions]
	);
	const [isCompacting, setIsCompacting] = useState(false);
	const [compactionError, setCompactionError] = useState<Error | null>(null);
	const [isPreparingMessage, setIsPreparingMessage] = useState(false);
	const [catalogDiagnostic, setCatalogDiagnostic] = useState<string | null>(
		null
	);
	const compactionAbortRef = useRef<AbortController | null>(null);
	const compactionOperationRef =
		useRef<Promise<CompactConversationResult> | null>(null);
	const overflowAttemptRef = useRef(0);
	const requestStartedAtRef = useRef<number | null>(null);
	const currentAssistantIdRef = useRef<string | null>(null);
	const agentRef = useRef<AgentId>("build");
	const resolvedAgentRef = useRef<ResolvedCodingAgent | undefined>(undefined);
	const modelRef = useRef<ChatModelSelection>(defaultChatModelSelection);
	const conversationModelRef = useRef<ChatModelSelection>(
		defaultChatModelSelection
	);
	const conversationVariantRef = useRef<ModelVariant | undefined>(undefined);
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
	const conversationRef = useRef<ConversationOperation | null>(null);
	const providerErrorRef = useRef<(error: unknown) => void>(() => undefined);

	const publishActiveMessages = useCallback(
		(messages: ConversationMessage[]) => {
			activeMessagesRef.current = messages;
			setActiveMessages(messages);
		},
		[]
	);
	const publishDisplayMessages = useCallback(
		(messages: ConversationMessage[]) => {
			displayMessagesRef.current = messages;
			setDisplayMessages(messages);
		},
		[]
	);
	const mergeDisplayMessages = useCallback(
		(nextMessages: readonly ConversationMessage[]): ConversationMessage[] => {
			const merged = [...displayMessagesRef.current];
			for (const message of nextMessages) {
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
			publishDisplayMessages(merged);
			return merged;
		},
		[publishDisplayMessages]
	);

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
		return (
			COMPACTION_REQUEST_OVERHEAD_TOKENS +
			Math.ceil(serializedContext.length / 4)
		);
	}, []);
	const summaryGenerator = useMemo(
		() => createDirectSummaryGenerator(connections),
		[connections]
	);
	const compactionModule = useMemo(
		() =>
			createConversationCompaction({
				attachmentStore: getConversationStore().attachmentStore,
				estimateTokens: (messages) =>
					estimateCompactionTokens(
						messages,
						estimateRuntimeRequestOverheadTokens()
					),
				store: getConversationStore(),
				summaryGenerator,
			}),
		[estimateRuntimeRequestOverheadTokens, summaryGenerator]
	);
	const getCompactionSettings = useCallback(
		(selection: ChatModelSelection = modelRef.current) =>
			getSettingsForModel(selection),
		[getSettingsForModel]
	);
	const runCompaction = useCallback(
		(
			trigger: CompactConversationInput["trigger"],
			focus?: string,
			nextMessages?: readonly ConversationMessage[],
			selection?: ChatModelSelection,
			compactionMessages?: readonly ConversationMessage[],
			selectionVariant?: ModelVariant
		): Promise<CompactConversationResult> => {
			const current = compactionOperationRef.current;
			if (current) {
				return current;
			}
			const compactionModel = selection ?? modelRef.current;
			const compactionVariant = selectionVariant ?? variantRef.current;
			const controller = new AbortController();
			compactionAbortRef.current = controller;
			const operation = (async () => {
				setIsCompacting(true);
				const transcriptMessages = nextMessages
					? mergeDisplayMessages(nextMessages)
					: displayMessagesRef.current;
				const conversationMessages = compactionMessages
					? [...compactionMessages]
					: transcriptMessages;
				const settings = await getCompactionSettings(compactionModel);
				const result = await compactionModule.compact({
					conversation: { messages: conversationMessages, sessionId },
					focus,
					model: compactionModel,
					...(compactionVariant === undefined
						? {}
						: { variant: compactionVariant }),
					settings: {
						enabled: settings.enabled,
						keepRecentTokens: settings.keepRecentTokens,
						maxMediaAttachments: settings.maxMediaAttachments,
						maxMediaBytes: settings.maxMediaBytes,
						maxMediaTokens: settings.maxMediaTokens,
						thresholdTokens: settings.thresholdTokens,
					},
					signal: controller.signal,
					trigger,
				});
				setCompactionError(null);
				publishActiveMessages(result.activeMessages);
				setCompactions((currentCompactions) =>
					currentCompactions.some(({ id }) => id === result.entry.id)
						? currentCompactions
						: [...currentCompactions, result.entry]
				);
				return result;
			})().finally(() => {
				if (compactionOperationRef.current === operation) {
					compactionOperationRef.current = null;
				}
				compactionAbortRef.current = null;
				setIsCompacting(false);
			});
			compactionOperationRef.current = operation;
			return operation;
		},
		[
			compactionModule,
			getCompactionSettings,
			mergeDisplayMessages,
			publishActiveMessages,
			sessionId,
		]
	);
	const cancelCompaction = useCallback(() => {
		compactionAbortRef.current?.abort();
	}, []);
	const maintainAfterTurn = useCallback(
		(
			messages: ConversationMessage[],
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
							error instanceof Error
								? error
								: new Error("Automatic compaction failed.")
						);
					}
				}
			};
			void compactIfNeeded();
		},
		[compactionModule, getCompactionSettings, runCompaction]
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
		}, [config, resolvePermission]);

	const resolveSkillForSubmit = useCallback(
		async (
			explicitSkillInput: SkillContext | undefined,
			anchoredMessage: ConversationMessage | undefined
		): Promise<
			| { ok: true; skill: SkillRequestContext | undefined }
			| { ok: false; reason: string }
		> => {
			const execution = skillExecutionRef.current;
			if (explicitSkillInput !== undefined) {
				if (execution === null) {
					return { ok: false, reason: "Skill catalog is unavailable" };
				}
				return activateExplicitSkill(explicitSkillInput, {
					execution,
					gate: toolGateState.gate,
				});
			}
			if (anchoredMessage === undefined || execution === null) {
				return { ok: true, skill: undefined };
			}
			const parsedSkill = conversationMessageSkillSchema.safeParse(
				anchoredMessage.metadata?.skill
			);
			if (!parsedSkill.success) {
				return { ok: true, skill: undefined };
			}
			if (!("instructions" in parsedSkill.data)) {
				const live = execution.catalog.entries.find(
					({ name }) => name === parsedSkill.data.name
				);
				if (live === undefined) {
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
		(assistantId: string, event: AgentTurnEvent): void => {
			const current = activeMessagesRef.current;
			const index = current.findIndex(({ id }) => id === assistantId);
			const existing: ConversationMessage =
				index === -1
					? { id: assistantId, parts: [], role: "assistant" }
					: (current[index] ?? {
							id: assistantId,
							parts: [],
							role: "assistant",
						});
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
							isConversationToolPart(part) &&
							part.toolCallId === event.toolCallId
					);
					const existingPart = parts[partIndex];
					if (
						partIndex === -1 ||
						existingPart === undefined ||
						!isConversationToolPart(existingPart)
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
			const nextMessage: ConversationMessage = { ...existing, parts };
			const nextMessages =
				index === -1
					? [...current, nextMessage]
					: current.map((message, messageIndex) =>
							messageIndex === index ? nextMessage : message
						);
			publishActiveMessages(nextMessages);
			mergeDisplayMessages([nextMessage]);
		},
		[mergeDisplayMessages, publishActiveMessages]
	);

	const finalizeRuntimeMessage = useCallback(
		(assistantId: string, event: AgentTurnTerminalEvent): void => {
			const current = activeMessagesRef.current;
			const index = current.findIndex(({ id }) => id === assistantId);
			const base =
				index === -1
					? { id: assistantId, parts: [], role: "assistant" as const }
					: current[index];
			if (base === undefined) {
				return;
			}
			const startedAt = requestStartedAtRef.current;
			const usage =
				event.type === "agent-turn-completed"
					? normalizeModelUsage(event.usage)
					: null;
			const terminalOutcome = terminalOutcomeForEvent(event);
			const metadata: ConversationMessageMetadata = {
				...(base.metadata ?? {}),
				agent: base.metadata?.agent ?? agentRef.current,
				interrupted: event.type === "agent-turn-interrupted",
				...(terminalOutcome === undefined ? {} : { terminalOutcome }),
				...(variantRef.current === undefined
					? {}
					: { variant: base.metadata?.variant ?? variantRef.current }),
				...(startedAt === null
					? {}
					: { responseTimeMs: Math.max(0, Date.now() - startedAt) }),
				...(usage === null ? {} : { usage }),
			};
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
			publishActiveMessages(safeMessages);
			mergeDisplayMessages(safeMessages);
		},
		[mergeDisplayMessages, publishActiveMessages]
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: latest-value refs intentionally keep turn callbacks current without rebuilding the turn.
	const runTurn = useCallback(
		async ({
			agent,
			delegation,
			model,
			resolvedAgent,
			skill,
			variant,
			modelMessages,
			signal,
		}: {
			agent: AgentId;
			delegation?: AgentTurnDelegation;
			model: ChatModelSelection;
			resolvedAgent: ResolvedCodingAgent;
			skill?: SkillRequestContext;
			variant?: ModelVariant;
			modelMessages: readonly ConversationMessage[];
			signal: AbortSignal;
		}): Promise<ConversationSendOutcome> => {
			setError(null);
			setViewState(undefined);
			setStatus("submitted");
			const store = getConversationStore();
			const turnId = createAgentTurnId();
			currentAssistantIdRef.current = `assistant-${turnId}`;
			let snapshot: McpCatalogSnapshot | undefined;
			let executionStarted = false;
			let currentTurn: AgentTurn | undefined;
			let terminalObserved = false;
			const commitRecord = (record: ConversationRecord) =>
				store.commitConversationRecord({
					...(delegation === undefined
						? {
								conversationModel: conversationModelRef.current,
								conversationVariant: conversationVariantRef.current,
							}
						: {}),
					record,
					sessionId,
				});
			try {
				const modelTarget = await resolveChatModelTarget(model, connections, {
					signal,
					...(variant === undefined ? {} : { variant }),
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
						agentId === undefined
							? resolveResourceLimitsRef.current()
							: resolveResourceLimitsForAgentRef.current(agentId),
				};
				const turn = buildAgentTurn({
					agent,
					delegation,
					modelMessages: hydratedMessages,
					modelTarget,
					resolvedAgent,
					skill,
					tools: createGatedCodingTools({
						agentId: agent,
						agentTools: resolvedAgent.visibleCodingTools,
						delegate: runtimeGatedToolingRef.current.delegate,
						executeMcpTool,
						gate: gatedTooling.gate,
						mcpSnapshot: snapshot,
						parentTurnId: turnId,
						resolveResourceLimits: gatedTooling.resolveResourceLimits,
						skillExecution: skillExecutionRef.current ?? undefined,
						skillTool: skillToolRef.current,
					}),
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
					onTerminal: (event) => {
						executionStarted = true;
						terminalObserved = true;
						if (currentAssistantIdRef.current !== null) {
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
				maintainAfterTurn(displayMessagesRef.current, model, variant);
				return { rejected: false };
			} catch (turnError) {
				setStatus("ready");
				return handleTurnFailure({
					agent,
					commitRecord,
					currentMessages: activeMessagesRef.current,
					currentTurn,
					delegation,
					error: turnError,
					executionStarted,
					mergeDisplayMessages,
					model,
					onProviderError: providerErrorRef.current,
					publishActiveMessages,
					setError,
					signal,
					terminalObserved,
					turnId,
					variant,
				});
			} finally {
				releaseTurnSnapshot({
					mcp,
					mcpSnapshotRef,
					snapshot,
				});
				currentAssistantIdRef.current = null;
			}
		},
		[
			connections,
			finalizeRuntimeMessage,
			maintainAfterTurn,
			mcp,
			mergeDisplayMessages,
			publishActiveMessages,
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
			return execute === undefined
				? Promise.reject(new Error("Delegation is unavailable."))
				: execute(request, signal);
		},
		gate: toolGateState.gate,
		resolveResourceLimits: (agentId) =>
			agentId === undefined
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
			return tool === undefined ? undefined : { execution, tool };
		},
		fallbackModelRef: modelRef,
		fallbackVariantRef: variantRef,
		gatedTooling: runtimeGatedToolingRef.current,
		mcp,
		resolveMcpPolicyForAgent: (agent) =>
			resolveMcpPolicyForAgentRef.current(agent),
		onViewState: setViewState,
		registry,
		sessionId,
	});

	const submit = useCallback(
		async (
			input: ConversationSendInput,
			signal: AbortSignal
		): Promise<ConversationSendOutcome> => {
			setCompactionError(null);
			approvalAbortHandledRef.current = false;
			overflowAttemptRef.current = 0;
			agentRef.current = input.agent;
			resolvedAgentRef.current = input.resolvedAgent;
			conversationModelRef.current = input.conversationModel;
			conversationVariantRef.current = input.conversationVariant;
			modelRef.current = input.model;
			variantRef.current = input.variant;
			requestStartedAtRef.current = Date.now();

			const prepared = await prepareConversationSubmission({
				getActiveMessages: () => activeMessagesRef.current,
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
				setIsPreparingMessage,
				signal,
			});
			if (prepared.kind !== "ready") {
				if (prepared.kind === "rejected" && prepared.error !== undefined) {
					setError(prepared.error);
				}
				return conversationOutcomeForPreparation(prepared, signal);
			}
			const { context: readyContext, messages: modelMessages } = prepared;
			if (prepared.newMessage !== undefined) {
				const userRecord = buildUserConversationRecord({
					agentId: input.agent,
					message: prepared.newMessage,
					model: input.model,
					turnId: createAgentTurnId(),
					variant: input.variant,
				});
				try {
					await getConversationStore().commitConversationRecord({
						conversationModel: input.conversationModel,
						conversationVariant: input.conversationVariant,
						record: userRecord,
						sessionId,
					});
				} catch (error) {
					const safeError =
						error instanceof Error
							? error
							: new Error("Could not save the prompt.");
					setError(safeError);
					return {
						rejected: true,
						reason: "Could not save the prompt.",
					};
				}
			}
			publishActiveMessages(modelMessages);
			mergeDisplayMessages(modelMessages);
			return runTurn({
				agent: input.agent,
				delegation: input.delegation,
				model: input.model,
				modelMessages,
				resolvedAgent: readyContext.resolvedAgent,
				signal,
				skill: readyContext.skill,
				variant: input.variant,
			});
		},
		[
			compactionModule,
			createTurnSkillExecution,
			getCompactionSettings,
			mergeDisplayMessages,
			publishActiveMessages,
			resolveSkillForSubmit,
			runCompaction,
			runTurn,
			sessionId,
		]
	);
	const submitRef = useLatest(submit);

	const interruptLatestAssistantMessage = useCallback(
		(preserveToolCallId?: string): void => {
			const targetIndex = findCurrentTurnInterruptTargetIndex(
				activeMessagesRef.current
			);
			if (targetIndex === -1) {
				return;
			}
			const target = activeMessagesRef.current[targetIndex];
			if (target === undefined) {
				return;
			}
			const startedAt = requestStartedAtRef.current;
			const finalized = finalizeAssistantMessageMetadata(target, {
				agent: agentRef.current,
				interrupted: true,
				model: modelRef.current,
				variant: variantRef.current,
				...(startedAt === null
					? {}
					: { responseTimeMs: Math.max(0, Date.now() - startedAt) }),
			});
			const next = [...activeMessagesRef.current];
			next[targetIndex] = finalized;
			const sanitized = sanitizeInterruptedMessagesForConversation(
				next,
				preserveToolCallId
			);
			publishActiveMessages(sanitized);
			mergeDisplayMessages(sanitized);
		},
		[mergeDisplayMessages, publishActiveMessages]
	);
	const abortApprovalTurn = useCallback(
		(toolCallId: string): void => {
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
		const originalMessage = displayMessagesRef.current.findLast(
			(message) => message.role === "user"
		);
		if (originalMessage === undefined) {
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
							input.conversation.messages,
							variantRef.current
						),
					compaction: compactionModule,
					compactionInput: {
						model: failedModel,
						settings: {
							enabled: settings.enabled,
							keepRecentTokens: settings.keepRecentTokens,
							maxMediaAttachments: settings.maxMediaAttachments,
							maxMediaBytes: settings.maxMediaBytes,
							maxMediaTokens: settings.maxMediaTokens,
							thresholdTokens: settings.thresholdTokens,
						},
					},
					conversation: {
						messages: displayMessagesRef.current,
						sessionId,
					},
					enabled: settings.overflowRecoveryAvailable,
					error: providerError,
					originalMessageId: originalMessage.id,
					replay: async ({ activeMessages, entry, originalMessageId }) => {
						publishActiveMessages(activeMessages);
						setCompactions((current) =>
							current.some(({ id }) => id === entry.id)
								? current
								: [...current, entry]
						);
						const operation = conversationRef.current;
						if (operation === null || !(await operation.waitForIdle())) {
							return;
						}
						const outcome = await operation.send({
							agent: agentRef.current,
							conversationModel: conversationModelRef.current,
							conversationVariant: conversationVariantRef.current,
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
					recoveryError instanceof Error
						? recoveryError
						: new Error("Context overflow recovery failed.")
				);
			}
		})();
	};

	const conversation = useMemo(
		() =>
			createConversationController({
				deadlineMs: AGENT_TURN_DEADLINE_MS,
				execute: async (input, signal) => {
					if (signal.aborted) {
						return conversationSendCancelled(signal);
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
					setError(
						error instanceof Error ? error : new Error("Conversation failed.")
					),
				resolveApproval: async (approvalId, outcome) => {
					const entry = approvalPanelsRef.current.entries.find(
						(candidate) => candidate.id === approvalId
					);
					if (entry === undefined) {
						throw new Error(
							`Conversation approval "${approvalId}" is unavailable.`
						);
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
		[
			approvalPanelsRef,
			approvalQueueRef,
			closeApprovalsRef,
			interruptLatestAssistantMessage,
			submitRef,
		]
	);
	conversationRef.current = conversation;

	return {
		cancelCompaction,
		catalogDiagnostic,
		compact: (focus?: string, selection?: ChatModelSelection) =>
			runCompaction("manual", focus, undefined, selection),
		compactions,
		conversation,
		error: compactionError ?? error,
		getCompactionSettings,
		isCompacting,
		isPreparingMessage,
		messages: displayMessages,
		status,
		viewState,
		activeMessages,
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

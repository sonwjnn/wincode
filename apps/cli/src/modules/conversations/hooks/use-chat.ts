import { useChat as useAiChat } from "@ai-sdk/react";
import {
	type AgentId,
	buildAgent,
	type CodingAgentUIMessage,
	codingMessageSkillSchema,
	codingToolDefinitions,
	type ResolvedAgentRuntime,
	type SkillContext,
	type SkillRequestContext,
	type SkillToolDefinition,
	sanitizeInterruptedMessagesForModel,
} from "@wincode/ai";
import { createUserMessage } from "@wincode/ai/client";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
	type ModelVariant,
} from "@wincode/ai/models";
import {
	type ChatAddToolOutputFunction,
	type FileUIPart,
	isToolUIPart,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentRegistry } from "@/modules/agents";
import { useConnections } from "@/modules/connections";
import {
	COMPACTION_REQUEST_OVERHEAD_TOKENS,
	type CompactConversationInput,
	type CompactConversationResult,
	type ConversationCompaction,
	ConversationCompactionError,
	createConversationCompaction,
	createDirectSummaryGenerator,
	estimateCompactionTokens,
	isCompactionSummaryMessage,
	isContextOverflowError,
	recoverContextOverflow,
	useCompactionSettings,
} from "@/modules/conversations/compaction";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import {
	type McpAddToolOutput,
	type McpCatalogSnapshot,
	type McpContextValue,
	useMcp,
} from "@/modules/mcp";
import { useToolPermission } from "@/modules/permissions";
import {
	buildSkillToolDefinition,
	createSkillExecution,
	createSkillSnapshot,
	discoverSkillCatalog,
	isSkillToolPart,
	type SkillCatalog,
	type SkillExecution,
	sanitizeSkillToolPart,
} from "@/modules/skills";
import { createToolGate, type ToolGate } from "@/modules/tool-gate/tool-gate";
import { useConfig } from "@/shared/config/config-provider";
import { useLatest } from "@/shared/hooks/use-latest";
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import {
	type ConversationOperation,
	type ConversationSendInput,
	type ConversationSendOutcome,
	createConversationOperation,
} from "../conversation-operation";
import type { AttachmentHydrationOptions } from "../storage/attachment-store";
import { getConversationStore } from "../storage/get-conversation-store";
import { type AutoSendGate, createAutoSendGate } from "./auto-send-gate";
import { createRoutingChatTransport } from "./routing-chat-transport";
import { createChatToolCallHandler } from "./tool-dispatch";
export const createChatMessageParts = (
	userText: string,
	fileMentions: CodingAgentUIMessage["parts"],
	files: FileUIPart[]
) => [{ text: userText, type: "text" as const }, ...fileMentions, ...files];

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

const persistMessagesBeforeSend = async (
	persist: (messages: CodingAgentUIMessage[]) => Promise<void>,
	messages: CodingAgentUIMessage[]
): Promise<boolean> => {
	try {
		await persist(messages);
		return true;
	} catch {
		return false;
	}
};

/**
 * Strips Skill bodies, base directories, and bundled resource paths from
 * `skill` tool parts so a finished turn's context never leaks into a later
 * execution. Loaded parts from the active turn keep their live payload; every
 * other part collapses to its sanitized activation metadata.
 */
export const sanitizeSkillToolParts = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] =>
	messages.map((message) => {
		if (!message.parts.some(isSkillToolPart)) {
			return message;
		}
		return {
			...message,
			parts: message.parts.map((part) =>
				isSkillToolPart(part) ? sanitizeSkillToolPart(part) : part
			),
		};
	});
export const findCurrentTurnAssistantIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const userIndex = messages.findLastIndex(({ role }) => role === "user");
	const assistantIndex = messages.findLastIndex(
		({ role }) => role === "assistant"
	);

	return assistantIndex > userIndex ? assistantIndex : -1;
};

/**
 * `chat.stop()` can run before the asynchronous approval gate emits its
 * output-error part. Keep the approved-input part terminal so that late output
 * can update it instead of finding that interruption already removed it.
 */
const INTERRUPTED_TOOL_ERROR = "Tool call interrupted";

const preserveInterruptedToolCall = (
	message: CodingAgentUIMessage,
	toolCallId: string
): CodingAgentUIMessage => {
	if (message.role !== "assistant" || message.metadata?.interrupted !== true) {
		return message;
	}
	const parts = message.parts.map(
		(part): CodingAgentUIMessage["parts"][number] => {
			if (
				!isToolUIPart(part) ||
				part.toolCallId !== toolCallId ||
				part.state !== "input-available"
			) {
				return part;
			}
			return {
				...part,
				errorText: INTERRUPTED_TOOL_ERROR,
				state: "output-error",
			};
		}
	);
	return { ...message, parts };
};

export const sanitizeInterruptedMessagesForConversation = (
	messages: CodingAgentUIMessage[],
	preserveToolCallId?: string
): CodingAgentUIMessage[] =>
	messages.flatMap((message) => {
		const preparedMessage =
			preserveToolCallId === undefined
				? message
				: preserveInterruptedToolCall(message, preserveToolCallId);
		const sanitized = sanitizeInterruptedMessagesForModel([preparedMessage]);
		if (sanitized.length > 0) {
			return sanitized;
		}
		if (
			preparedMessage.role === "assistant" &&
			preparedMessage.metadata?.interrupted === true
		) {
			return [{ ...preparedMessage, parts: [] }];
		}
		return [];
	});

export const findCurrentTurnInterruptTargetIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const assistantIndex = findCurrentTurnAssistantIndex(messages);
	if (assistantIndex !== -1) {
		return assistantIndex;
	}

	return messages.findLastIndex(({ role }) => role === "user");
};
export const finalizeAssistantMessageMetadata = (
	message: CodingAgentUIMessage,
	context: {
		agent: AgentId;
		model: ChatModelSelection;
		variant?: ModelVariant;
		interrupted: boolean;
		responseTimeMs?: number;
	}
): CodingAgentUIMessage => ({
	...message,
	metadata: (() => {
		const metadata = message.metadata ?? {};
		const nextMetadata: CodingAgentUIMessage["metadata"] = {
			...metadata,
			agent: message.metadata?.agent ?? context.agent,
			interrupted: context.interrupted,
			model: message.metadata?.model ?? context.model,
		};

		if (message.metadata?.variant !== undefined) {
			nextMetadata.variant = message.metadata.variant;
		} else if (context.variant !== undefined) {
			nextMetadata.variant = context.variant;
		}

		if (context.responseTimeMs !== undefined) {
			nextMetadata.responseTimeMs = context.responseTimeMs;
		}

		return nextMetadata;
	})(),
});
export type ActivateExplicitSkillDeps = {
	execution: SkillExecution;
	gate: ToolGate;
};

/**
 * Resolves and authorizes an explicit `/skill-name arguments` submission
 * before the first model call. Rejection (policy, approval, or an unknown
 * Skill) preserves the input and sends nothing; acceptance consumes one
 * activation slot and returns the request-scoped Skill payload.
 */
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
	if (!entry) {
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
export function useChat(
	sessionId: string,
	initialMessages: CodingAgentUIMessage[],
	initialActiveMessages: CodingAgentUIMessage[] = initialMessages,
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
		resolveMcpPolicy,
		resolvePermission,
		resolveResourceLimits,
		sandbox,
		service,
	} = useToolPermission();
	// The transport is memoized on a coarser dependency set than the Agent-scoped
	// policy resolver, so read the latest resolver through a ref to avoid building
	// a snapshot against a stale Agent's MCP policy.
	const resolveMcpPolicyRef = useLatest(resolveMcpPolicy);
	const resolvePermissionRef = useLatest(resolvePermission);
	const resolveResourceLimitsRef = useLatest(resolveResourceLimits);
	const approvalAbortHandledRef = useRef(false);
	const abortApprovalTurnRef = useRef<(toolCallId: string) => void>(
		() => undefined
	);
	// Rebuild the conversation-scoped gate when its conversation or authorization
	// dependencies change, rejecting pending requests from the previous scope.
	// biome-ignore lint/correctness/useExhaustiveDependencies: latest-value refs intentionally keep the gate current without rebuilding transport state.
	const toolGateState = useMemo(() => {
		const approvalQueue = createApprovalQueue<ToolApprovalRequest>();
		return {
			approvalQueue,
			gate: createToolGate({
				approvalQueue,
				onAbort: (request) => {
					if (request.toolCallId !== undefined) {
						abortApprovalTurnRef.current(request.toolCallId);
					}
				},
				openApproval,
				resolvePermission: () => resolvePermissionRef.current(),
				resolveResourceLimits: () => resolveResourceLimitsRef.current(),
				sandbox,
				service,
			}),
			scope: sessionId,
		};
	}, [openApproval, sandbox, service, sessionId]);
	const approvalQueueRef = useLatest(toolGateState.approvalQueue);
	const closeApprovalsRef = useLatest(closeApprovals);
	useEffect(
		() => () => {
			toolGateState.approvalQueue.rejectAll();
			closeApprovals();
		},
		[closeApprovals, toolGateState]
	);
	const toolGate = toolGateState.gate;
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const dynamicToolOutputRef = useRef<McpAddToolOutput | null>(null);
	const interruptedMessageIdsRef = useRef(new Set<string>());
	const requestStartedAtRef = useRef<number | null>(null);
	const setMessagesRef = useRef<
		((messages: CodingAgentUIMessage[]) => void) | undefined
	>(undefined);
	const displayMessagesRef = useRef<CodingAgentUIMessage[]>([
		...initialMessages,
	]);
	const activeMessagesRef = useRef<CodingAgentUIMessage[]>([
		...initialActiveMessages,
	]);
	const [displayMessages, setDisplayMessages] = useState<
		CodingAgentUIMessage[]
	>(() => [...initialMessages]);
	const [compactions, setCompactions] = useState<ConversationCompaction[]>(
		() => [...initialCompactions]
	);
	const [isCompacting, setIsCompacting] = useState(false);
	const [compactionError, setCompactionError] = useState<Error | null>(null);
	const compactionAbortRef = useRef<AbortController | null>(null);
	const compactionOperationRef =
		useRef<Promise<CompactConversationResult> | null>(null);
	const overflowAttemptRef = useRef(0);
	const autoSendRef = useRef<
		(options: { messages: CodingAgentUIMessage[] }) => Promise<boolean>
	>(async () => false);
	const providerErrorRef = useRef<(error: Error) => void>(() => undefined);
	const conversationRef = useRef<ConversationOperation | null>(null);
	const agentRef = useRef<AgentId>(buildAgent.id);
	const resolvedAgentRef = useRef<ResolvedAgentRuntime | undefined>(undefined);
	const modelRef = useRef<ChatModelSelection>(defaultChatModelSelection);
	// The conversation-level choice (prompt-config selection) and the
	// effective selection are separate values on purpose (ADR-0006): the
	// session row records the choice, message metadata records what ran.
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
	// The execution-scoped Skill Activation state: one catalog snapshot and
	// activation context per user turn, replaced at every submit/continue.
	const skillExecutionRef = useRef<SkillExecution | null>(null);
	const skillToolRef = useRef<SkillToolDefinition | undefined>(undefined);
	const [isPreparingMessage, setIsPreparingMessage] = useState(false);
	const [catalogDiagnostic, setCatalogDiagnostic] = useState<string | null>(
		null
	);
	const autoSendGateRef = useRef<AutoSendGate | null>(null);
	if (autoSendGateRef.current === null) {
		autoSendGateRef.current = createAutoSendGate();
	}
	const autoSendGate = autoSendGateRef.current;

	const persistDisplayMessages = (
		messages: CodingAgentUIMessage[] = displayMessagesRef.current
	): Promise<void> =>
		getConversationStore().persistMessages({
			agent: agentRef.current,
			messages,
			model: conversationModelRef.current,
			sessionId,
			variant: conversationVariantRef.current,
		});

	const mergeDisplayMessages = (
		nextMessages: readonly CodingAgentUIMessage[]
	): CodingAgentUIMessage[] => {
		const merged = [...displayMessagesRef.current];
		for (const message of nextMessages) {
			if (isCompactionSummaryMessage(message)) {
				continue;
			}
			const existingIndex = merged.findIndex(({ id }) => id === message.id);
			if (existingIndex === -1) {
				merged.push(message);
			} else {
				merged[existingIndex] = message;
			}
		}
		displayMessagesRef.current = merged;
		setDisplayMessages(merged);
		return merged;
	};

	const removeDisplayMessage = (messageId: string) => {
		const nextMessages = displayMessagesRef.current.filter(
			({ id }) => id !== messageId
		);
		displayMessagesRef.current = nextMessages;
		setDisplayMessages(nextMessages);
		return nextMessages;
	};

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
	const getCompactionSettings = (
		selection: ChatModelSelection = modelRef.current
	) => getSettingsForModel(selection);

	const runCompaction = (
		trigger: CompactConversationInput["trigger"],
		focus?: string,
		nextMessages?: readonly CodingAgentUIMessage[],
		selection?: ChatModelSelection,
		compactionMessages?: readonly CodingAgentUIMessage[],
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
			try {
				await persistDisplayMessages(transcriptMessages);
			} catch (error) {
				throw new ConversationCompactionError(
					"persistence-failed",
					"Conversation transcript could not be persisted before compaction.",
					{ cause: error }
				);
			}
			const settings = await getCompactionSettings(compactionModel);
			const result = await compactionModule.compact({
				conversation: {
					messages: conversationMessages,
					sessionId,
				},
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
			activeMessagesRef.current = result.activeMessages;
			setMessagesRef.current?.(result.activeMessages);
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
	};

	const cancelCompaction = () => {
		compactionAbortRef.current?.abort();
	};

	const hasPendingTools = (
		messages: readonly CodingAgentUIMessage[]
	): boolean => {
		const lastMessage = messages.at(-1);
		if (!lastMessage || lastMessage.role !== "assistant") {
			return false;
		}
		return lastMessage.parts.some(
			(part) =>
				isToolUIPart(part) &&
				part.state !== "output-available" &&
				part.state !== "output-error" &&
				part.state !== "output-denied"
		);
	};
	const maintainAfterTurn = (
		messages: CodingAgentUIMessage[],
		selection: ChatModelSelection,
		selectionVariant?: ModelVariant
	) => {
		if (hasPendingTools(messages)) {
			return;
		}
		void getCompactionSettings(selection).then((settings) => {
			if (
				!(
					settings.autoAvailable &&
					compactionModule.needsCompaction(messages, settings)
				)
			) {
				return;
			}
			return runCompaction(
				"threshold",
				undefined,
				messages,
				selection,
				undefined,
				selectionVariant
			).catch((error) => {
				if (isBenignCompactionError(error)) {
					return;
				}
				// Keep the completed turn and expose maintenance failure to the UI.
				setCompactionError(
					error instanceof Error
						? error
						: new Error("Automatic compaction failed.")
				);
			});
		});
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: the MCP policy ref intentionally stays live without rebuilding transport.
	const transport = useMemo(() => {
		// The transport snapshots the MCP catalog once per send; mirror the same
		// immutable snapshot into a ref so dynamic tool dispatch resolves against
		// the exact catalog the request was built from.
		const mcpWithSnapshotRef: McpContextValue = {
			...mcp,
			createSnapshot: async (agent: AgentId) => {
				// Resolve the snapshot for the executing Agent's effective MCP policy
				// so deny composes out unavailable tools and ask/allow are visible.
				const agentPolicy = await resolveMcpPolicyRef.current();
				const snapshot = await mcp.createSnapshot(agent, agentPolicy);
				mcpSnapshotRef.current = snapshot;
				return snapshot;
			},
		};

		return createRoutingChatTransport(
			sessionId,
			agentRef,
			modelRef,
			variantRef,
			registry,
			connections,
			mcpWithSnapshotRef,
			skillToolRef,
			attachmentBudgetRef
		);
	}, [connections, mcp, registry, sessionId]);

	const finalizeAssistantMessages = (messages: CodingAgentUIMessage[]) => {
		const startedAt = requestStartedAtRef.current;

		const responseTimeMs =
			startedAt === null ? undefined : Math.max(0, Date.now() - startedAt);
		const assistantIndex = messages.findLastIndex(
			(message) => message.role === "assistant"
		);

		if (assistantIndex === -1) {
			return messages;
		}

		const assistantMessage = messages[assistantIndex];
		if (!assistantMessage) {
			return messages;
		}

		const nextMessages = [...messages];
		nextMessages[assistantIndex] = {
			...finalizeAssistantMessageMetadata(assistantMessage, {
				agent: agentRef.current,
				interrupted: interruptedMessageIdsRef.current.has(assistantMessage.id),
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};

		return nextMessages;
	};

	const persistMessages = (messages: CodingAgentUIMessage[]) => {
		void persistDisplayMessages(mergeDisplayMessages(messages)).catch(
			() => undefined
		);
	};

	const finalizeAndPersistMessages = (messages: CodingAgentUIMessage[]) => {
		// An interrupted/cut-off turn drops tool calls without a terminal output.
		// An aborted approval is converted to output-error before this step, so
		// its late result remains replay-safe.
		const finalizedMessages = sanitizeInterruptedMessagesForConversation(
			finalizeAssistantMessages(messages)
		);
		activeMessagesRef.current = finalizedMessages;
		setMessagesRef.current?.(finalizedMessages);
		persistMessages(finalizedMessages);
	};

	const shouldAutoSend = (options: {
		messages: CodingAgentUIMessage[];
	}): Promise<boolean> => autoSendRef.current(options);
	const chat = useAiChat<CodingAgentUIMessage>({
		id: sessionId,
		messages: initialActiveMessages,
		onFinish: ({ messages, isAbort, isError }) => {
			finalizeAndPersistMessages(messages);
			if (isAbort || isError) {
				return;
			}
			maintainAfterTurn(messages, modelRef.current, variantRef.current);
		},
		onError: (providerError) => {
			// A stream error leaves the partial assistant message in state.
			// Mark it interrupted so the next request reduces it like any cut-off
			// turn (its unfinished tool calls must never replay), and persist it
			// so a reload shows the turn as it failed.
			const lastAssistantIndex = chat.messages.findLastIndex(
				({ role }) => role === "assistant"
			);
			if (lastAssistantIndex !== -1) {
				const lastAssistant = chat.messages[lastAssistantIndex];
				if (lastAssistant) {
					interruptedMessageIdsRef.current.add(lastAssistant.id);
				}
			}
			finalizeAndPersistMessages(chat.messages);
			providerErrorRef.current(providerError);
		},
		onToolCall: createChatToolCallHandler({
			addToolOutputRef,
			dynamicToolOutputRef,
			gate: toolGate,
			mcp,
			mcpSnapshotRef,
			resolvedAgentRef,
			resolveResourceLimits: () => resolveResourceLimitsRef.current(),
			skillExecutionRef,
		}),
		sendAutomaticallyWhen: shouldAutoSend,
		transport,
	});
	const chatRef = useLatest(chat);
	activeMessagesRef.current = chat.messages;
	addToolOutputRef.current = chat.addToolOutput;
	dynamicToolOutputRef.current = (config) => {
		// AI SDK matches dynamic output by toolCallId. The reserved type-only tool
		// supplies its unknown output channel without pretending an MCP tool is one
		// of the concrete coding tools.
		if (config.state === "output-error") {
			return chat.addToolOutput({
				errorText: config.errorText ?? "Tool call failed",
				state: "output-error",
				tool: "__dynamic",
				toolCallId: config.toolCallId,
			});
		}
		return chat.addToolOutput({
			output: config.output,
			tool: "__dynamic",
			toolCallId: config.toolCallId,
		});
	};
	setMessagesRef.current = chat.setMessages;

	autoSendRef.current = async ({ messages }) => {
		if (!autoSendGate.shouldAutoSend({ messages })) {
			return false;
		}
		const turnModel = modelRef.current;
		const settings = await getCompactionSettings(turnModel);
		if (
			!(
				settings.midTurnAvailable &&
				compactionModule.needsCompaction(messages, settings)
			)
		) {
			return true;
		}
		autoSendGate.pause();
		try {
			await runCompaction("mid-turn", undefined, messages, turnModel);
			autoSendGate.resume();
			return true;
		} catch (error) {
			if (isBenignCompactionError(error)) {
				autoSendGate.disable();
				return false;
			}
			setCompactionError(
				error instanceof Error
					? error
					: new Error("Mid-turn compaction failed.")
			);
			autoSendGate.disable();
			return false;
		}
	};

	providerErrorRef.current = (providerError) => {
		if (overflowAttemptRef.current > 0) {
			return;
		}
		overflowAttemptRef.current = 1;
		const failedModel = modelRef.current;
		const failedVariant = variantRef.current;
		void (async () => {
			const settings = await getCompactionSettings(failedModel);
			if (!settings.overflowRecoveryAvailable) {
				return;
			}
			const originalMessage = displayMessagesRef.current.findLast(
				(message) => message.role === "user"
			);
			if (!originalMessage) {
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
							failedVariant
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
						activeMessagesRef.current = activeMessages;
						setMessagesRef.current?.(activeMessages);
						setCompactions((currentCompactions) =>
							currentCompactions.some(({ id }) => id === entry.id)
								? currentCompactions
								: [...currentCompactions, entry]
						);
						setCompactionError(null);
						const replayMessage = displayMessagesRef.current.find(
							(message) => message.id === originalMessageId
						);
						if (!replayMessage) {
							throw new Error("Original message disappeared during replay.");
						}
						const operation = conversationRef.current;
						if (!operation) {
							throw new Error(
								"Conversation operation is unavailable during overflow recovery."
							);
						}
						if (!(await operation.waitForIdle())) {
							return;
						}
						const outcome = await operation.send({
							agent: agentRef.current,
							conversationModel: conversationModelRef.current,
							conversationVariant: conversationVariantRef.current,
							messageId: originalMessageId,
							model: failedModel,
							resolvedAgent: resolvedAgentRef.current,
							variant: failedVariant,
						});
						if (outcome.rejected) {
							throw new Error(outcome.reason);
						}
					},
				});
			} catch (error) {
				if (isContextOverflowError(providerError)) {
					setCompactionError(
						error instanceof Error
							? error
							: new Error("Context overflow recovery failed.")
					);
				}
			}
		})();
	};

	const interruptLatestAssistantMessage = (preserveToolCallId?: string) => {
		autoSendGate.disable();
		const startedAt = requestStartedAtRef.current;
		const responseTimeMs =
			startedAt === null ? undefined : Math.max(0, Date.now() - startedAt);
		const targetIndex = findCurrentTurnInterruptTargetIndex(chat.messages);

		if (targetIndex === -1) {
			chat.stop();
			return;
		}

		const targetMessage = chat.messages[targetIndex];
		if (!targetMessage) {
			chat.stop();
			return;
		}

		if (targetMessage.role === "assistant") {
			interruptedMessageIdsRef.current.add(targetMessage.id);
		}
		const nextMessages = [...chat.messages];
		nextMessages[targetIndex] = {
			...finalizeAssistantMessageMetadata(targetMessage, {
				agent: agentRef.current,
				interrupted: true,
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};
		// Drop unfinished tool calls from the interrupted turn. The approval call
		// identified above is converted to a terminal fallback so its late
		// output-error can replace it after chat.stop() settles.
		const sanitizedMessages = sanitizeInterruptedMessagesForConversation(
			nextMessages,
			preserveToolCallId
		);

		activeMessagesRef.current = sanitizedMessages;
		setMessagesRef.current?.(sanitizedMessages);
		persistMessages(sanitizedMessages);
		chat.stop();
	};
	const abortApprovalTurn = (toolCallId: string) => {
		if (approvalAbortHandledRef.current) {
			return;
		}
		approvalAbortHandledRef.current = true;
		toolGateState.approvalQueue.rejectAll();
		closeApprovals();
		interruptLatestAssistantMessage(toolCallId);
	};
	abortApprovalTurnRef.current = abortApprovalTurn;

	const createTurnSkillExecution = async (): Promise<SkillExecution> => {
		const permission = await resolvePermission();
		const catalog = await discoverSkillCatalog(config, (name) =>
			permission.decide("skill", name)
		);
		const execution = createSkillExecution(catalog);
		skillExecutionRef.current = execution;
		skillToolRef.current = buildSkillToolDefinition(catalog);
		setCatalogDiagnostic(summarizeCatalogDiagnostics(catalog));
		return execution;
	};

	/**
	 * Re-authorizes a Skill carried by an anchored message (explicit Skill at
	 * session creation, or a retried turn): sanitized activation metadata after
	 * a reload, the full snapshot in memory. Either way the Skill is
	 * re-snapshotted from current content so the transport injects the live body.
	 */
	const reauthorizeAnchoredSkill = async (
		anchoredMessage: CodingAgentUIMessage
	): Promise<
		| { ok: true; skill: SkillRequestContext | undefined }
		| { ok: false; reason: string }
	> => {
		const parsedSkill = codingMessageSkillSchema.safeParse(
			anchoredMessage.metadata?.skill
		);
		if (!parsedSkill.success) {
			return { ok: true, skill: undefined };
		}

		const execution = skillExecutionRef.current;
		if (execution === null) {
			return { ok: true, skill: undefined };
		}

		const activation = await activateExplicitSkill(
			{
				arguments: parsedSkill.data.arguments ?? "",
				instructions: "",
				name: parsedSkill.data.name,
			},
			{
				execution,
				gate: toolGate,
			}
		);
		if (!activation.ok) {
			return { ok: false, reason: activation.reason };
		}
		return { ok: true, skill: activation.skill };
	};

	/**
	 * Resolves the Skill for a submit: an explicit `/skill` submission wins;
	 * otherwise an anchored message's Skill metadata is re-authorized.
	 */
	const resolveSkillForSubmit = async (
		explicitSkillInput: SkillContext | undefined,
		anchoredMessage: CodingAgentUIMessage | undefined
	): Promise<
		| { ok: true; skill: SkillRequestContext | undefined }
		| { ok: false; reason: string }
	> => {
		if (explicitSkillInput) {
			const execution = skillExecutionRef.current;
			if (execution === null) {
				return { ok: false, reason: "Skill catalog is unavailable" };
			}
			const activation = await activateExplicitSkill(explicitSkillInput, {
				execution,
				gate: toolGate,
			});
			if (!activation.ok) {
				return { ok: false, reason: activation.reason };
			}
			return { ok: true, skill: activation.skill };
		}

		if (anchoredMessage) {
			return reauthorizeAnchoredSkill(anchoredMessage);
		}

		return { ok: true, skill: undefined };
	};

	/**
	 * Re-sends an already-stored user message (HomeView auto-start): the
	 * message stays in place with freshly resolved metadata, skill tool parts
	 * are sanitized, and the turn runs against the exact stored content.
	 */
	const prepareForSend = async (
		candidateMessages: readonly CodingAgentUIMessage[] = activeMessagesRef.current
	): Promise<string | null> => {
		const sendModel = modelRef.current;
		const waitingError = await waitForCompaction(
			compactionOperationRef.current
		);
		if (waitingError) {
			return waitingError;
		}
		const settings = await getCompactionSettings(sendModel);
		attachmentBudgetRef.current = {
			maxAttachments: settings.maxMediaAttachments,
			maxBytes: settings.maxMediaBytes,
			maxTokens: settings.maxMediaTokens,
		};
		const shouldCompact =
			settings.autoAvailable &&
			compactionModule.needsCompaction(candidateMessages, settings);
		if (!shouldCompact) {
			return null;
		}
		try {
			await runCompaction("threshold", undefined, undefined, sendModel);
			return null;
		} catch (error) {
			return isBenignCompactionError(error)
				? null
				: compactionErrorMessage(error);
		}
	};
	const conversationSendCancelled = (): ConversationSendOutcome => ({
		rejected: true,
		reason: "Conversation send cancelled.",
	});

	const submitAnchoredMessage = async (
		anchoredMessage: CodingAgentUIMessage,
		metadata: CodingAgentUIMessage["metadata"],
		signal: AbortSignal
	): Promise<ConversationSendOutcome> => {
		const previousMessages = activeMessagesRef.current;
		const nextMessages = sanitizeSkillToolParts(previousMessages);
		activeMessagesRef.current = nextMessages;
		chat.setMessages(nextMessages);
		const persisted = await persistMessagesBeforeSend(
			persistDisplayMessages,
			nextMessages
		);
		if (!persisted) {
			activeMessagesRef.current = previousMessages;
			chat.setMessages(previousMessages);
			return {
				rejected: true,
				reason: "Conversation transcript could not be persisted.",
			};
		}
		if (signal.aborted) {
			return conversationSendCancelled();
		}
		setIsPreparingMessage(true);
		try {
			if (signal.aborted) {
				return conversationSendCancelled();
			}
			await chat.sendMessage({
				messageId: anchoredMessage.id,
				metadata,
				parts: anchoredMessage.parts,
			});
			return { rejected: false };
		} finally {
			setIsPreparingMessage(false);
		}
	};

	const submitFreshMessage = async ({
		files,
		metadata,
		userText,
		signal,
	}: {
		files: FileUIPart[];
		metadata: CodingAgentUIMessage["metadata"];
		userText?: string;
		signal: AbortSignal;
	}): Promise<ConversationSendOutcome> => {
		if (userText === undefined) {
			return { rejected: true, reason: "No prompt to submit" };
		}
		const fileMentions = await resolveFileMentionParts(userText);
		const optimisticMessage = createUserMessage(
			userText,
			metadata,
			fileMentions,
			files
		);
		let durableOptimisticMessage: CodingAgentUIMessage | undefined;
		try {
			[durableOptimisticMessage] =
				await getConversationStore().externalizeAttachments(
					[optimisticMessage],
					signal,
					{ rejectInvalid: true }
				);
		} catch {
			if (signal.aborted) {
				return conversationSendCancelled();
			}
			return {
				rejected: true,
				reason: "Attachment data could not be stored.",
			};
		}
		if (!durableOptimisticMessage) {
			return {
				rejected: true,
				reason: "The prompt could not be prepared.",
			};
		}
		const candidateMessages = [
			...sanitizeSkillToolParts(activeMessagesRef.current),
			durableOptimisticMessage,
		];
		const promptPreparationError = await prepareForSend(candidateMessages);
		if (promptPreparationError) {
			return { rejected: true, reason: promptPreparationError };
		}
		if (signal.aborted) {
			return conversationSendCancelled();
		}
		const priorActiveMessages = activeMessagesRef.current;
		const optimisticMessages = [
			...sanitizeSkillToolParts(priorActiveMessages),
			durableOptimisticMessage,
		];
		const nextDisplayMessages = mergeDisplayMessages(optimisticMessages);
		activeMessagesRef.current = optimisticMessages;
		chat.setMessages(optimisticMessages);
		setIsPreparingMessage(true);
		const persisted = await persistMessagesBeforeSend(
			persistDisplayMessages,
			nextDisplayMessages
		);
		if (!persisted) {
			activeMessagesRef.current = priorActiveMessages;
			chat.setMessages(priorActiveMessages);
			removeDisplayMessage(durableOptimisticMessage.id);
			setIsPreparingMessage(false);
			return {
				rejected: true,
				reason: "Conversation transcript could not be persisted.",
			};
		}
		if (signal.aborted) {
			activeMessagesRef.current = priorActiveMessages;
			chat.setMessages(priorActiveMessages);
			const rollbackMessages = removeDisplayMessage(
				durableOptimisticMessage.id
			);
			await persistMessagesBeforeSend(persistDisplayMessages, rollbackMessages);
			setIsPreparingMessage(false);
			return conversationSendCancelled();
		}

		try {
			await chat.sendMessage({
				messageId: durableOptimisticMessage.id,
				metadata,
				parts: durableOptimisticMessage.parts,
			});
			return { rejected: false };
		} catch (error) {
			const nextMessages = activeMessagesRef.current.filter(
				({ id }) => id !== durableOptimisticMessage.id
			);
			activeMessagesRef.current = nextMessages;
			chat.setMessages(nextMessages);
			void persistDisplayMessages(
				removeDisplayMessage(durableOptimisticMessage.id)
			).catch(() => undefined);
			throw error;
		} finally {
			setIsPreparingMessage(false);
		}
	};

	const submit = async (
		{
			agent,
			conversationModel,
			conversationVariant,
			model,
			variant,
			resolvedAgent,
			userText,
			files = [],
			skill,
			messageId,
		}: ConversationSendInput,
		signal: AbortSignal
	): Promise<ConversationSendOutcome> => {
		approvalAbortHandledRef.current = false;
		setCompactionError(null);
		overflowAttemptRef.current = 0;
		autoSendGate.enable();
		agentRef.current = agent;
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();

		const preparationError = await prepareForSend();
		if (preparationError) {
			return { rejected: true, reason: preparationError };
		}
		if (signal.aborted) {
			return conversationSendCancelled();
		}
		await createTurnSkillExecution();
		if (signal.aborted) {
			return conversationSendCancelled();
		}

		// An anchored turn (HomeView auto-start) re-executes the prompt message
		// the session row already stores instead of appending a new one.
		let anchoredMessage: CodingAgentUIMessage | undefined;
		if (messageId !== undefined) {
			anchoredMessage = activeMessagesRef.current.find(
				({ id }) => id === messageId
			);
			if (anchoredMessage?.role !== "user") {
				return {
					rejected: true,
					reason: "The stored message to continue is unavailable",
				};
			}
		}

		const resolution = await resolveSkillForSubmit(skill, anchoredMessage);
		if (!resolution.ok) {
			return { rejected: true, reason: resolution.reason };
		}

		const metadata = {
			agent,
			model,
			variant,
			...(resolution.skill
				? { skill: createSkillSnapshot(resolution.skill, "explicit") }
				: {}),
		};

		if (signal.aborted) {
			return conversationSendCancelled();
		}
		if (anchoredMessage) {
			return submitAnchoredMessage(anchoredMessage, metadata, signal);
		}

		return submitFreshMessage({ files, metadata, signal, userText });
	};

	const submitRef = useLatest(submit);
	const interruptRef = useLatest(interruptLatestAssistantMessage);
	const conversation = useMemo(
		() =>
			createConversationOperation({
				execute: async (input, signal) => {
					if (signal.aborted) {
						return {
							rejected: true,
							reason: "Conversation send cancelled.",
						};
					}
					const stop = () => {
						chatRef.current.stop();
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
				onInterrupt: (preserveToolCallId) =>
					interruptRef.current(preserveToolCallId),
			}),
		[approvalQueueRef, chatRef, closeApprovalsRef, interruptRef, submitRef]
	);
	conversationRef.current = conversation;
	return {
		cancelCompaction,
		catalogDiagnostic,
		compact: (focus?: string, selection?: ChatModelSelection) =>
			runCompaction("manual", focus, undefined, selection),
		compactions,
		conversation,
		error: compactionError ?? chat.error,
		getCompactionSettings,
		isCompacting,
		messages: displayMessages,
		status: chat.status,
		isPreparingMessage,
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

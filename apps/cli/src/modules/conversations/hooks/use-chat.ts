import { useChat as useAiChat } from "@ai-sdk/react";
import {
	type AgentId,
	buildAgent,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	codingMessageSkillSchema,
	defaultChatModelSelection,
	getChatModelRoute,
	type ModelVariant,
	type ResolvedAgentRuntime,
	type SkillContext,
	type SkillRequestContext,
	type SkillToolDefinition,
	sanitizeInterruptedMessagesForModel,
} from "@wincode/ai";
import { createUserMessage } from "@wincode/ai/client";
import type { ChatAddToolOutputFunction, FileUIPart } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAgentRegistry } from "@/modules/agents";
import { useConnections } from "@/modules/connections";
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
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { getConversationStore } from "../storage/get-conversation-store";
import { type AutoSendGate, createAutoSendGate } from "./auto-send-gate";
import { createRoutingChatTransport } from "./routing-chat-transport";
import { createChatToolCallHandler } from "./tool-dispatch";

type SubmitChatParams = {
	agent: AgentId;
	conversationModel: ChatModelSelection;
	conversationVariant?: ModelVariant;
	model: ChatModelSelection;
	variant?: ModelVariant;
	resolvedAgent?: ResolvedAgentRuntime;
	/**
	 * The prompt to submit as a fresh user message. Omit it (and pass
	 * `messageId`) to run the turn anchored at an already-stored user message.
	 */
	userText?: string;
	files?: FileUIPart[];
	skill?: SkillContext;
	/**
	 * Anchor the turn at an existing stored user message instead of appending a
	 * new one. Used by the HomeView auto-start path: the session row already
	 * carries the prompt message, so the turn re-sends that exact message with
	 * freshly resolved Agent/model/Skill state.
	 */
	messageId?: string;
};
/**
 * The settled outcome of submitting a chat prompt. Explicit Skill rejection
 * resolves with `{ rejected: true }` so the caller can preserve the input and
 * attachments without sending a prompt.
 */
export type SubmitChatOutcome =
	| { readonly rejected: false }
	| { readonly rejected: true; readonly reason: string };
export const createChatMessageParts = (
	userText: string,
	fileMentions: CodingAgentUIMessage["parts"],
	files: FileUIPart[]
) => [{ text: userText, type: "text" as const }, ...fileMentions, ...files];

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
export const notifyHostedCompletion = (
	model: ChatModelSelection,
	onHostedCompletion?: () => void
): void => {
	if (getChatModelRoute(model) === "hosted") {
		onHostedCompletion?.();
	}
};
export const findCurrentTurnAssistantIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const userIndex = messages.findLastIndex(({ role }) => role === "user");
	const assistantIndex = messages.findLastIndex(
		({ role }) => role === "assistant"
	);

	return assistantIndex > userIndex ? assistantIndex : -1;
};
export const sanitizeInterruptedMessagesForConversation = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] =>
	messages.flatMap((message) => {
		const sanitized = sanitizeInterruptedMessagesForModel([message]);
		if (sanitized.length > 0) {
			return sanitized;
		}
		if (
			message.role === "assistant" &&
			message.metadata?.interrupted === true
		) {
			return [{ ...message, parts: [] }];
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
	onHostedCompletion?: () => void
) {
	const connections = useConnections();
	const mcp = useMcp();
	const config = useConfig();
	const registry = useAgentRegistry();
	const {
		closeApprovals,
		openApproval,
		resolveMcpPolicy,
		resolvePermission,
		sandbox,
		service,
	} = useToolPermission();
	// The transport is memoized on a coarser dependency set than the Agent-scoped
	// policy resolver, so read the latest resolver through a ref to avoid building
	// a snapshot against a stale Agent's MCP policy.
	const resolveMcpPolicyRef = useRef(resolveMcpPolicy);
	resolveMcpPolicyRef.current = resolveMcpPolicy;
	const resolvePermissionRef = useRef(resolvePermission);
	resolvePermissionRef.current = resolvePermission;
	const approvalAbortHandledRef = useRef(false);
	const abortApprovalTurnRef = useRef<() => void>(() => undefined);
	// Rebuild the conversation-scoped gate when its conversation or authorization
	// dependencies change, rejecting pending requests from the previous scope.
	const toolGateState = useMemo(() => {
		const approvalQueue = createApprovalQueue<ToolApprovalRequest>();
		return {
			approvalQueue,
			gate: createToolGate({
				approvalQueue,
				onAbort: (request) => {
					if (request.toolCallId !== undefined) {
						abortApprovalTurnRef.current();
					}
				},
				openApproval,
				resolvePermission: () => resolvePermissionRef.current(),
				sandbox,
				service,
			}),
			scope: sessionId,
		};
	}, [openApproval, sandbox, service, sessionId]);
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
			skillToolRef
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
		getConversationStore()
			.persistMessages({
				agent: agentRef.current,
				messages,
				model: conversationModelRef.current,
				sessionId,
				variant: conversationVariantRef.current,
			})
			.catch(() => undefined);
	};

	const finalizeAndPersistMessages = (messages: CodingAgentUIMessage[]) => {
		// An interrupted/cut-off turn drops its unfinished tool calls (no result
		// ever lands for them): persisting them would restore a stuck running
		// tool block on the next session load.
		const finalizedMessages = sanitizeInterruptedMessagesForConversation(
			finalizeAssistantMessages(messages)
		);
		setMessagesRef.current?.(finalizedMessages);
		persistMessages(finalizedMessages);
	};

	const chat = useAiChat<CodingAgentUIMessage>({
		id: sessionId,
		messages: initialMessages,
		onFinish: ({ messages }) => {
			finalizeAndPersistMessages(messages);
			notifyHostedCompletion(modelRef.current, onHostedCompletion);
		},
		onError: () => {
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
		},
		onToolCall: createChatToolCallHandler({
			addToolOutputRef,
			dynamicToolOutputRef,
			gate: toolGate,
			mcp,
			mcpSnapshotRef,
			resolvedAgentRef,
			skillExecutionRef,
		}),
		sendAutomaticallyWhen: autoSendGate.shouldAutoSend,
		transport,
	});
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

	const interruptLatestAssistantMessage = () => {
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
		// Drop the in-flight tool calls of the interrupted turn so the UI never
		// shows a stuck running block and the next reload cannot restore one.
		const sanitizedMessages =
			sanitizeInterruptedMessagesForConversation(nextMessages);

		setMessagesRef.current?.(sanitizedMessages);
		persistMessages(sanitizedMessages);
		chat.stop();
	};
	const abortApprovalTurn = () => {
		if (approvalAbortHandledRef.current) {
			return;
		}
		approvalAbortHandledRef.current = true;
		toolGateState.approvalQueue.rejectAll();
		closeApprovals();
		interruptLatestAssistantMessage();
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
	const submitAnchoredMessage = async (
		anchoredMessage: CodingAgentUIMessage,
		metadata: CodingAgentUIMessage["metadata"]
	): Promise<SubmitChatOutcome> => {
		const nextMessages = sanitizeSkillToolParts(chat.messages);
		chat.setMessages(nextMessages);
		persistMessages(nextMessages);
		setIsPreparingMessage(true);
		try {
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

	const submit = async ({
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
	}: SubmitChatParams): Promise<SubmitChatOutcome> => {
		approvalAbortHandledRef.current = false;
		autoSendGate.enable();
		agentRef.current = agent;
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();

		await createTurnSkillExecution();

		// An anchored turn (HomeView auto-start) re-executes the prompt message
		// the session row already stores instead of appending a new one.
		let anchoredMessage: CodingAgentUIMessage | undefined;
		if (messageId !== undefined) {
			anchoredMessage = chat.messages.find(({ id }) => id === messageId);
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

		if (anchoredMessage) {
			return submitAnchoredMessage(anchoredMessage, metadata);
		}

		if (userText === undefined) {
			return { rejected: true, reason: "No prompt to submit" };
		}

		const optimisticMessage = createUserMessage(userText, metadata, [], files);
		const optimisticMessages = [
			...sanitizeSkillToolParts(chat.messages),
			optimisticMessage,
		];
		chat.setMessages(optimisticMessages);
		// Persist the user message before the stream starts so a hard kill
		// leaves the turn visible in storage instead of a dangling send.
		persistMessages(optimisticMessages);
		setIsPreparingMessage(true);

		try {
			const fileMentions = await resolveFileMentionParts(userText);
			await chat.sendMessage({
				messageId: optimisticMessage.id,
				metadata,
				parts: createChatMessageParts(userText, fileMentions, files),
			});
			return { rejected: false };
		} catch (error) {
			const nextMessages = chat.messages.filter(
				({ id }) => id !== optimisticMessage.id
			);
			chat.setMessages(nextMessages);
			persistMessages(nextMessages);
			throw error;
		} finally {
			setIsPreparingMessage(false);
		}
	};

	return {
		abort: chat.stop,
		catalogDiagnostic,
		error: chat.error,
		interrupt: interruptLatestAssistantMessage,
		messages: chat.messages,
		status: chat.status,
		isPreparingMessage,
		submit,
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

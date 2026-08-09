import { useChat as useAiChat } from "@ai-sdk/react";
import {
	type AgentId,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	defaultChatModelSelection,
	getChatModelRoute,
	getLegacyModeForAgent,
	type ModelVariant,
	type ModeType,
	type ResolvedAgentRuntime,
	readToolSchema,
	type SkillContext,
} from "@wincode/ai";
import {
	createUserMessage,
	handleCodingAgentToolCall,
} from "@wincode/ai/client";
import type { WorkspacePolicy } from "@wincode/ai/workspace";
import {
	type ChatAddToolOutputFunction,
	type ChatOnToolCallCallback,
	type FileUIPart,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useMemo, useRef, useState } from "react";
import { useConnections } from "@/modules/connections";
import { resolveFileMentionParts } from "@/modules/file-mentions";
import {
	type McpAddToolOutput,
	type McpCatalogSnapshot,
	type McpContextValue,
	useMcp,
} from "@/modules/mcp";
import {
	canonicalizeReadResource,
	type ToolPermission,
	type ToolPermissionRuntime,
	useToolPermission,
} from "@/modules/permissions";
import { createApprovalController } from "@/shared/providers/approval/approval-controller";
import type { ToolApprovalRequest } from "@/shared/providers/approval/ui/tool-approval-dialog";
import { getConversationStore } from "../storage/get-conversation-store";
import { createSkillSnapshot } from "../utils";
import { createRoutingChatTransport } from "./routing-chat-transport";

type SubmitChatParams = {
	agent: AgentId;
	conversationModel: ChatModelSelection;
	conversationVariant?: ModelVariant;
	model: ChatModelSelection;
	variant?: ModelVariant;
	resolvedAgent?: ResolvedAgentRuntime;
	userText: string;
	files?: FileUIPart[];
	skill?: SkillContext;
};

type MutableRefObject<T> = { current: T };

export type ChatToolCallHandlerDeps = {
	addToolOutputRef: MutableRefObject<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>;
	handleCodingAgentToolCall?: typeof handleCodingAgentToolCall;
	mcp: Pick<McpContextValue, "handleDynamicToolCall">;
	mcpSnapshotRef: MutableRefObject<McpCatalogSnapshot | null>;
	modeRef: MutableRefObject<ModeType>;
	openApproval: ToolPermissionRuntime["openApproval"];
	permissionRef: MutableRefObject<ToolPermission>;
	resolvePermission?: ToolPermissionRuntime["resolvePermission"];
	sandbox: WorkspacePolicy;
};

const getReadInputPath = (input: unknown): string | undefined => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return;
	}
	const candidate = (input as { path?: unknown }).path;
	return typeof candidate === "string" ? candidate : undefined;
};

const READ_TOOL_IDENTITY = [{ label: "tool", value: "read" }] as const;

/**
 * Enforces the Tool Permission policy for a static coding tool call. Only
 * `read` is gated in this slice: the input path is canonicalized through the
 * workspace sandbox, and a `deny` decision or a rejected/cancelled `ask`
 * decision settles the call with an observable tool error without invoking
 * the static tool runner. An allowed or approved call runs the runner.
 */
const gateStaticReadToolCall = async (
	options: Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0],
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
	permission: ToolPermission,
	openApproval: ToolPermissionRuntime["openApproval"],
	sandbox: WorkspacePolicy
): Promise<boolean> => {
	const toolCall = options.toolCall;
	const inputPath = getReadInputPath(toolCall.input);
	if (toolCall.toolName !== "read" || inputPath === undefined) {
		return true;
	}

	let resource: string;
	try {
		resource = await canonicalizeReadResource(inputPath, sandbox);
	} catch {
		Promise.resolve(
			addToolOutput({
				errorText: `Read path is outside the workspace: ${inputPath}`,
				state: "output-error",
				tool: toolCall.toolName,
				toolCallId: toolCall.toolCallId,
			})
		).catch(() => undefined);
		return false;
	}
	const decision = permission.decide("read", resource);

	if (decision === "deny") {
		// Policy errors are emitted without awaiting, mirroring the tool-call
		// dispatch below: awaiting chat tool output here would deadlock the
		// chat executor at input-available.
		Promise.resolve(
			addToolOutput({
				errorText: `Read denied by policy: ${resource}`,
				state: "output-error",
				tool: toolCall.toolName,
				toolCallId: toolCall.toolCallId,
			})
		).catch(() => undefined);
		return false;
	}

	if (decision === "ask") {
		const request: ToolApprovalRequest = {
			description: readToolSchema.description,
			identity: [...READ_TOOL_IDENTITY, { label: "resource", value: resource }],
			input: toolCall.input,
		};
		const controller = createApprovalController<ToolApprovalRequest>();
		openApproval(request, controller);
		const approved = await controller.request(request);
		if (!approved) {
			Promise.resolve(
				addToolOutput({
					errorText: `Read was not approved: ${resource}`,
					state: "output-error",
					tool: toolCall.toolName,
					toolCallId: toolCall.toolCallId,
				})
			).catch(() => undefined);
			return false;
		}
	}

	return true;
};

/**
 * Dispatches AI SDK tool calls to the MCP handler for dynamic tools and to the
 * coding-agent handler otherwise. The AI SDK awaits `onToolCall`, but
 * `addToolOutput` queues on the same chat executor, so neither promise is
 * returned or awaited here or tool execution deadlocks at input-available.
 */
export const createChatToolCallHandler =
	({
		addToolOutputRef,
		handleCodingAgentToolCall: runStaticToolCall = handleCodingAgentToolCall,
		mcp,
		mcpSnapshotRef,
		modeRef,
		openApproval,
		permissionRef,
		resolvePermission,
		sandbox,
	}: ChatToolCallHandlerDeps): ChatOnToolCallCallback<CodingAgentUIMessage> =>
	(options) => {
		const addToolOutput = addToolOutputRef.current;

		if (!addToolOutput) {
			return;
		}

		if (options.toolCall.dynamic) {
			// The AI SDK types addToolOutput for static coding tools, but dynamic
			// MCP tools carry arbitrary names; runtime matching is by toolCallId,
			// so bridge the type here.
			const mcpAddToolOutput = addToolOutput as unknown as McpAddToolOutput;
			Promise.resolve(
				mcp.handleDynamicToolCall(
					mcpSnapshotRef.current,
					options.toolCall,
					mcpAddToolOutput
				)
			).catch(() => undefined);
			return;
		}

		Promise.resolve(
			(async () => {
				if (
					!(await gateStaticReadToolCall(
						options,
						addToolOutput,
						resolvePermission
							? await resolvePermission()
							: permissionRef.current,
						openApproval,
						sandbox
					))
				) {
					return;
				}
				await runStaticToolCall(addToolOutput, modeRef.current)(options);
			})()
		).catch(() => undefined);
	};

export const createChatMessageParts = (
	userText: string,
	fileMentions: CodingAgentUIMessage["parts"],
	files: FileUIPart[]
) => [{ text: userText, type: "text" as const }, ...fileMentions, ...files];

export const getContinuationChatParams = (
	agent: AgentId,
	model: ChatModelSelection,
	variant?: ModelVariant
): { agent: AgentId; model: ChatModelSelection; variant?: ModelVariant } => ({
	agent,
	model,
	...(variant === undefined ? {} : { variant }),
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

export const findCurrentTurnInterruptTargetIndex = (
	messages: CodingAgentUIMessage[]
): number => {
	const assistantIndex = findCurrentTurnAssistantIndex(messages);
	if (assistantIndex !== -1) {
		return assistantIndex;
	}

	return messages.findLastIndex(({ role }) => role === "user");
};

export const getOriginatingUserMessageId = (
	messages: CodingAgentUIMessage[]
): string | undefined => messages.findLast(({ role }) => role === "user")?.id;

export const finalizeAssistantMessageMetadata = (
	message: CodingAgentUIMessage,
	context: {
		agent: AgentId;
		mode: ModeType;
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
			mode: message.metadata?.mode ?? context.mode,
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

export function useChat(
	sessionId: string,
	initialMessages: CodingAgentUIMessage[],
	onHostedCompletion?: () => void
) {
	const connections = useConnections();
	const mcp = useMcp();
	const { openApproval, permissionRef, resolvePermission, sandbox } =
		useToolPermission();
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const interruptedMessageIdsRef = useRef(new Set<string>());
	const requestStartedAtRef = useRef<number | null>(null);
	const setMessagesRef = useRef<
		((messages: CodingAgentUIMessage[]) => void) | undefined
	>(undefined);
	const agentRef = useRef<AgentId>("build");
	const modeRef = useRef<ModeType>(getLegacyModeForAgent("build"));
	const resolvedAgentRef = useRef<ResolvedAgentRuntime | undefined>(undefined);
	const modelRef = useRef<ChatModelSelection>(defaultChatModelSelection);
	const conversationModelRef = useRef<ChatModelSelection>(
		defaultChatModelSelection
	);
	const conversationVariantRef = useRef<ModelVariant | undefined>(undefined);
	const variantRef = useRef<ModelVariant | undefined>(undefined);
	const mcpSnapshotRef = useRef<McpCatalogSnapshot | null>(null);
	const [isPreparingMessage, setIsPreparingMessage] = useState(false);

	const transport = useMemo(() => {
		// The transport snapshots the MCP catalog once per send; mirror the same
		// immutable snapshot into a ref so dynamic tool dispatch resolves against
		// the exact catalog the request was built from.
		const mcpWithSnapshotRef: McpContextValue = {
			...mcp,
			createSnapshot: async (mode: ModeType) => {
				const snapshot = await mcp.createSnapshot(mode);
				mcpSnapshotRef.current = snapshot;
				return snapshot;
			},
		};

		return createRoutingChatTransport(
			sessionId,
			modeRef,
			resolvedAgentRef,
			modelRef,
			variantRef,
			connections,
			mcpWithSnapshotRef
		);
	}, [connections, mcp, sessionId]);

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
				mode: modeRef.current,
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
				mode: modeRef.current,
				model: conversationModelRef.current,
				sessionId,
				variant: conversationVariantRef.current,
			})
			.catch(() => undefined);
	};

	const finalizeAndPersistMessages = (messages: CodingAgentUIMessage[]) => {
		const finalizedMessages = finalizeAssistantMessages(messages);
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
		onToolCall: createChatToolCallHandler({
			addToolOutputRef,
			mcp,
			mcpSnapshotRef,
			modeRef,
			openApproval,
			permissionRef,
			resolvePermission,
			sandbox,
		}),
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
		transport,
	});
	addToolOutputRef.current = chat.addToolOutput;
	setMessagesRef.current = chat.setMessages;

	const interruptLatestAssistantMessage = () => {
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
				mode: modeRef.current,
				model: modelRef.current,
				responseTimeMs,
				variant: variantRef.current,
			}),
		};

		setMessagesRef.current?.(nextMessages);
		persistMessages(nextMessages);
		chat.stop();
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
	}: SubmitChatParams) => {
		agentRef.current = agent;
		modeRef.current = getLegacyModeForAgent(agent);
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();
		const metadata = {
			agent,
			mode: modeRef.current,
			model,
			variant,
			...(skill ? { skill: createSkillSnapshot(skill) } : {}),
		};
		const optimisticMessage = createUserMessage(userText, metadata, [], files);
		chat.setMessages((messages) => [...messages, optimisticMessage]);
		setIsPreparingMessage(true);

		try {
			const fileMentions = await resolveFileMentionParts(userText);
			return await chat.sendMessage({
				messageId: optimisticMessage.id,
				metadata,
				parts: createChatMessageParts(userText, fileMentions, files),
			});
		} catch (error) {
			chat.setMessages((messages) =>
				messages.filter(({ id }) => id !== optimisticMessage.id)
			);
			throw error;
		} finally {
			setIsPreparingMessage(false);
		}
	};
	const continueLastMessage = (
		agent: AgentId,
		model: ChatModelSelection,
		variant?: ModelVariant,
		resolvedAgent?: ResolvedAgentRuntime,
		conversationModel: ChatModelSelection = model,
		conversationVariant: ModelVariant | undefined = variant
	) => {
		agentRef.current = agent;
		modeRef.current = getLegacyModeForAgent(agent);
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();
		return chat.sendMessage();
	};

	return {
		abort: chat.stop,
		continueLastMessage,
		error: chat.error,
		interrupt: interruptLatestAssistantMessage,
		messages: chat.messages,
		status: chat.status,
		isPreparingMessage,
		submit,
	};
}

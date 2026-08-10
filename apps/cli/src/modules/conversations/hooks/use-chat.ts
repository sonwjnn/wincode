import { useChat as useAiChat } from "@ai-sdk/react";
import {
	type AgentId,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type CodingToolName,
	codingToolDefinitions,
	codingToolNames,
	defaultChatModelSelection,
	getChatModelRoute,
	getLegacyModeForAgent,
	type ModelVariant,
	type ModeType,
	type ResolvedAgentRuntime,
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
	canonicalizeResource,
	STATIC_TOOL_PERMISSION_ACTIONS,
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

const STATIC_TOOL_LABELS = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	list: "List",
	grep: "Grep",
} as const satisfies Record<CodingToolName, string>;

// The workspace-relative POSIX resource that `list` gates against when no path
// is supplied and the sandbox canonicalizes the workspace root to an empty path.
const WORKSPACE_ROOT_RESOURCE = ".";

const isCodingToolName = (name: string): name is CodingToolName =>
	(codingToolNames as readonly string[]).includes(name);

const getStringField = (input: unknown, field: string): string | undefined => {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return;
	}
	const candidate = (input as Record<string, unknown>)[field];
	return typeof candidate === "string" ? candidate : undefined;
};

type GateResource =
	| { kind: "path"; input: string }
	| { kind: "literal"; value: string };

/**
 * Resolves the Permission resource for a static coding tool call. Read, write,
 * edit, and list gate against a filesystem path (list defaults to the workspace
 * root), while grep gates against its requested regular expression verbatim. A
 * tool call missing its required input is left ungated so the runner reports the
 * validation error.
 */
const resolveGateResource = (
	tool: CodingToolName,
	input: unknown
): GateResource | undefined => {
	if (tool === "grep") {
		const pattern = getStringField(input, "pattern");
		return pattern === undefined
			? undefined
			: { kind: "literal", value: pattern };
	}
	if (tool === "list") {
		return {
			input: getStringField(input, "path") ?? WORKSPACE_ROOT_RESOURCE,
			kind: "path",
		};
	}
	const path = getStringField(input, "path");
	return path === undefined ? undefined : { input: path, kind: "path" };
};

const emitToolCallError = (
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
	tool: CodingToolName,
	toolCallId: string,
	errorText: string
): void => {
	// Policy errors are emitted without awaiting, mirroring the tool-call
	// dispatch below: awaiting chat tool output here would deadlock the chat
	// executor at input-available.
	Promise.resolve(
		addToolOutput({
			errorText,
			state: "output-error",
			tool,
			toolCallId,
		})
	).catch(() => undefined);
};

/**
 * Enforces the Tool Permission policy for a static coding tool call. The tool's
 * actual resource is normalized immediately before execution — path resources
 * are canonicalized through the workspace sandbox, grep uses its regex — and the
 * governing action (`edit` covers both write and edit) is evaluated. A `deny`
 * decision or a rejected/cancelled `ask` decision settles the call with an
 * observable tool error without invoking the static tool runner. An allowed or
 * approved call runs the runner.
 */
const gateStaticToolCall = async (
	options: Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0],
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
	permission: ToolPermission,
	openApproval: ToolPermissionRuntime["openApproval"],
	sandbox: WorkspacePolicy
): Promise<boolean> => {
	const toolCall = options.toolCall;
	if (!isCodingToolName(toolCall.toolName)) {
		return true;
	}
	const tool = toolCall.toolName;
	const gate = resolveGateResource(tool, toolCall.input);
	if (gate === undefined) {
		return true;
	}
	const label = STATIC_TOOL_LABELS[tool];

	let resource: string;
	if (gate.kind === "path") {
		try {
			const canonical = await canonicalizeResource(gate.input, sandbox);
			resource = canonical === "" ? WORKSPACE_ROOT_RESOURCE : canonical;
		} catch {
			emitToolCallError(
				addToolOutput,
				tool,
				toolCall.toolCallId,
				`${label} path is outside the workspace: ${gate.input}`
			);
			return false;
		}
	} else {
		resource = gate.value;
	}

	const decision = permission.decide(
		STATIC_TOOL_PERMISSION_ACTIONS[tool],
		resource
	);

	if (decision === "deny") {
		emitToolCallError(
			addToolOutput,
			tool,
			toolCall.toolCallId,
			`${label} denied by policy: ${resource}`
		);
		return false;
	}

	if (decision === "ask") {
		const request: ToolApprovalRequest = {
			description: codingToolDefinitions[tool].description,
			identity: [
				{ label: "tool", value: tool },
				{ label: "resource", value: resource },
			],
			input: toolCall.input,
			safety: permission.safety,
		};
		const controller = createApprovalController<ToolApprovalRequest>();
		openApproval(request, controller);
		const approved = await controller.request(request);
		if (!approved) {
			emitToolCallError(
				addToolOutput,
				tool,
				toolCall.toolCallId,
				`${label} was not approved: ${resource}`
			);
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
					!(await gateStaticToolCall(
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

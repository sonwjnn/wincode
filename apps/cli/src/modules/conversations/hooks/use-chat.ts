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
	type ModelVariant,
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
	MCP_PERMISSION_RESOURCE,
	type McpAddToolOutput,
	type McpApprovalDecision,
	type McpApprovalGate,
	type McpCatalogSnapshot,
	type McpContextValue,
	type McpSnapshotTool,
	useMcp,
} from "@/modules/mcp";
import {
	canonicalizeResource,
	type PermissionDecision,
	type PermissionService,
	resolveApproval,
	STATIC_TOOL_PERMISSION_ACTIONS,
	type ToolPermission,
	type ToolPermissionRuntime,
	useToolPermission,
} from "@/modules/permissions";
import {
	type ApprovalQueue,
	createApprovalQueue,
} from "@/shared/providers/approval/approval-queue";
import { formatRejectionFeedback } from "@/shared/providers/approval/format";
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
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	handleCodingAgentToolCall?: typeof handleCodingAgentToolCall;
	mcp: Pick<McpContextValue, "handleDynamicToolCall">;
	mcpSnapshotRef: MutableRefObject<McpCatalogSnapshot | null>;
	openApproval: ToolPermissionRuntime["openApproval"];
	permissionRef: MutableRefObject<ToolPermission>;
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>;
	resolvePermission?: ToolPermissionRuntime["resolvePermission"];
	sandbox: WorkspacePolicy;
	service: PermissionService;
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
type StaticToolGateDeps = {
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	openApproval: ToolPermissionRuntime["openApproval"];
	permission: ToolPermission;
	sandbox: WorkspacePolicy;
	service: PermissionService;
};

/**
 * The settled outcome of gating one tool call through the shared Permission
 * engine and approval machinery: `deny` blocked it by policy, `reject` means the
 * user declined an ask (carrying any bounded correction feedback), and `allow`
 * clears it to run. Callers map this onto their own emit/return shape.
 */
type ToolApprovalGateResult =
	| { kind: "allow" }
	| { kind: "deny" }
	| { kind: "reject"; feedback?: string };

type ResolveToolApprovalDeps = {
	action: string;
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	decision: PermissionDecision;
	openApproval: ToolPermissionRuntime["openApproval"];
	request: ToolApprovalRequest;
	resource: string;
	safety: boolean;
	service: PermissionService;
};

/**
 * The single approval path shared by static coding tools and dynamic MCP tools.
 * It applies temporary grants and auto approval to the raw policy `decision`
 * (`resolveApproval`), and for an `ask` enqueues the request on the conversation
 * approval queue, opens the shared dialog, awaits the outcome, records an
 * "always" grant against the exact `(action, resource)` key, and surfaces reject
 * feedback. Both tool families resolve through this one function so their
 * once/always/reject/auto behaviour can never drift apart.
 */
const resolveToolApproval = async ({
	action,
	approvalQueue,
	decision,
	openApproval,
	request,
	resource,
	safety,
	service,
}: ResolveToolApprovalDeps): Promise<ToolApprovalGateResult> => {
	const effective = resolveApproval({
		action,
		decision,
		isAutoApproval: () => service.isAutoApproval(),
		isGranted: (grantedAction, grantedResource) =>
			service.isGranted(grantedAction, grantedResource),
		resource,
		safety,
	});
	if (effective === "deny") {
		return { kind: "deny" };
	}
	if (effective === "allow") {
		return { kind: "allow" };
	}
	const handle = approvalQueue.request(request);
	openApproval(request, {
		allow: (remember) => handle.allow(remember),
		cancel: () => handle.rejectSelf(),
		reject: (feedback) => approvalQueue.rejectAll(feedback),
	});
	const outcome = await handle.outcome;
	if (outcome.decision === "reject") {
		return {
			feedback: formatRejectionFeedback(outcome.feedback),
			kind: "reject",
		};
	}
	if (outcome.remember) {
		service.grant(action, resource);
	}
	return { kind: "allow" };
};

const gateStaticToolCall = async (
	options: Parameters<ChatOnToolCallCallback<CodingAgentUIMessage>>[0],
	{
		addToolOutput,
		approvalQueue,
		openApproval,
		permission,
		sandbox,
		service,
	}: StaticToolGateDeps
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

	const action = STATIC_TOOL_PERMISSION_ACTIONS[tool];
	const request: ToolApprovalRequest = {
		description: codingToolDefinitions[tool].description,
		identity: [
			{ label: "tool", value: tool },
			{ label: "resource", value: resource },
		],
		input: toolCall.input,
		safety: permission.safety,
	};
	const result = await resolveToolApproval({
		action,
		approvalQueue,
		decision: permission.decide(action, resource),
		openApproval,
		request,
		resource,
		safety: permission.safety,
		service,
	});

	if (result.kind === "deny") {
		emitToolCallError(
			addToolOutput,
			tool,
			toolCall.toolCallId,
			`${label} denied by policy: ${resource}`
		);
		return false;
	}

	if (result.kind === "reject") {
		emitToolCallError(
			addToolOutput,
			tool,
			toolCall.toolCallId,
			result.feedback === undefined
				? `${label} was not approved: ${resource}`
				: `${label} was not approved: ${resource} — ${result.feedback}`
		);
		return false;
	}

	return true;
};

type McpApprovalGateDeps = {
	approvalQueue: ApprovalQueue<ToolApprovalRequest>;
	openApproval: ToolPermissionRuntime["openApproval"];
	service: PermissionService;
};

/**
 * Builds the shared-approval gate for one dynamic MCP tool call. It resolves
 * through the same {@link resolveToolApproval} helper as static coding tools —
 * one temporary-grant store, auto-approval flag, conversation approval queue,
 * and approval dialog — keyed by the tool's logical name and the single `*`
 * resource. The composed decision already baked the Agent+server policy and any
 * safety ceiling into `tool.policy`/`tool.safety`, so grants and auto approval
 * may satisfy an ordinary ask, a safety ask always prompts, and an explicit deny
 * is never bypassed. An "always" outcome grants the exact logical name.
 */
export const createMcpApprovalGate =
	({
		approvalQueue,
		openApproval,
		service,
	}: McpApprovalGateDeps): McpApprovalGate =>
	(tool: McpSnapshotTool, input: unknown): Promise<McpApprovalDecision> => {
		const request: ToolApprovalRequest = {
			description: tool.description,
			identity: [
				{ label: "tool", value: tool.logicalName },
				{ label: "resource", value: MCP_PERMISSION_RESOURCE },
			],
			input,
			safety: tool.safety,
		};
		// The composed decision already folded the Agent+server policy and any
		// safety ceiling into tool.policy/tool.safety, so the shared resolver
		// applies grants/auto/ask exactly as it does for a static coding tool. Its
		// `ToolApprovalGateResult` is a subset of `McpApprovalDecision`.
		return resolveToolApproval({
			action: tool.logicalName,
			approvalQueue,
			decision: tool.policy,
			openApproval,
			request,
			resource: MCP_PERMISSION_RESOURCE,
			safety: tool.safety,
			service,
		});
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
		approvalQueue,
		handleCodingAgentToolCall: runStaticToolCall = handleCodingAgentToolCall,
		mcp,
		mcpSnapshotRef,
		openApproval,
		permissionRef,
		resolvedAgentRef,
		resolvePermission,
		sandbox,
		service,
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
					mcpAddToolOutput,
					createMcpApprovalGate({ approvalQueue, openApproval, service })
				)
			).catch(() => undefined);
			return;
		}

		Promise.resolve(
			(async () => {
				if (
					!(await gateStaticToolCall(options, {
						addToolOutput,
						approvalQueue,
						openApproval,
						permission: resolvePermission
							? await resolvePermission()
							: permissionRef.current,
						sandbox,
						service,
					}))
				) {
					return;
				}
				await runStaticToolCall(
					addToolOutput,
					resolvedAgentRef.current?.visibleCodingTools ?? codingToolNames
				)(options);
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

export function useChat(
	sessionId: string,
	initialMessages: CodingAgentUIMessage[],
	onHostedCompletion?: () => void
) {
	const connections = useConnections();
	const mcp = useMcp();
	const {
		openApproval,
		permissionRef,
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
	// The approval queue is conversation-scoped: rejecting one request settles
	// every pending approval in this conversation without touching other
	// conversations' queues. Created once per conversation via lazy ref init.
	const approvalQueueRef = useRef<ApprovalQueue<ToolApprovalRequest> | null>(
		null
	);
	if (approvalQueueRef.current === null) {
		approvalQueueRef.current = createApprovalQueue<ToolApprovalRequest>();
	}
	const addToolOutputRef =
		useRef<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>(null);
	const interruptedMessageIdsRef = useRef(new Set<string>());
	const requestStartedAtRef = useRef<number | null>(null);
	const setMessagesRef = useRef<
		((messages: CodingAgentUIMessage[]) => void) | undefined
	>(undefined);
	const agentRef = useRef<AgentId>("build");
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
			approvalQueue: approvalQueueRef.current,
			mcp,
			mcpSnapshotRef,
			openApproval,
			permissionRef,
			resolvedAgentRef,
			resolvePermission,
			sandbox,
			service,
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
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();
		const metadata = {
			agent,
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

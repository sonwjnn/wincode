import { useChat as useAiChat } from "@ai-sdk/react";
import {
	type AgentId,
	buildAgent,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	type CodingToolName,
	codingMessageSkillSchema,
	codingToolNames,
	defaultChatModelSelection,
	getChatModelRoute,
	type ModelVariant,
	type ResolvedAgentRuntime,
	type SkillContext,
	type SkillRequestContext,
	type SkillToolDefinition,
	skillToolInputSchema,
} from "@wincode/ai";
import {
	createUserMessage,
	handleCodingAgentToolCall,
} from "@wincode/ai/client";
import {
	type ChatAddToolOutputFunction,
	type ChatOnToolCallCallback,
	type FileUIPart,
	isToolUIPart,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
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
	type SkillActivationResult,
	type SkillCatalog,
	type SkillExecution,
	type SkillToolResult,
	sampleSkillResources,
	sanitizeSkillToolPart,
} from "@/modules/skills";
import { createToolGate, type ToolGate } from "@/modules/tool-gate/tool-gate";
import { useConfig } from "@/shared/config/config-provider";
import { createApprovalQueue } from "@/shared/providers/approval/approval-queue";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import { getConversationStore } from "../storage/get-conversation-store";
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

export type AutoSendGate = {
	/**
	 * Gates `sendAutomaticallyWhen` so an interrupted turn never resumes on
	 * its own. The AI SDK auto-continues a turn whenever the last assistant
	 * step's tool calls all have outputs AND no request is in flight — which
	 * includes two windows where the user's interrupt must win:
	 *
	 * 1. the tool-execution gap: the stream ended (status "ready"), tool
	 *    executions are still running, and the user interrupts;
	 *    `chat.stop()` no-ops on "ready", so without this gate the turn
	 *    resumes the moment the in-flight tool output lands.
	 * 2. mid-stream abort: the abort finalizes the request, but tool
	 *    executions that were already dispatched keep running and their
	 *    late outputs would re-trigger `sendAutomaticallyWhen`.
	 *
	 * A single per-turn boolean is sufficient: within a live session,
	 * `isBusy` (which includes in-flight tool executions) blocks a new
	 * submit until the interrupted turn's outputs have landed, so no stale
	 * execution can fire auto-send after `enable()`; after a reload no
	 * execution is in flight at all.
	 */
	/** Disables auto-send: the current turn was interrupted. */
	disable: () => void;
	/** Re-enables auto-send: a new turn is starting. */
	enable: () => void;
	shouldAutoSend: (arg: { messages: CodingAgentUIMessage[] }) => boolean;
};

export const createAutoSendGate = (): AutoSendGate => {
	let turnInterrupted = false;
	return {
		disable: () => {
			turnInterrupted = true;
		},
		enable: () => {
			turnInterrupted = false;
		},
		shouldAutoSend: ({ messages }) =>
			!turnInterrupted &&
			lastAssistantMessageIsCompleteWithToolCalls({ messages }),
	};
};

const isTerminalToolOutputState = (state: string): boolean =>
	state === "output-available" || state === "output-error";

/**
 * True when the latest assistant step still has tool executions in flight.
 * Mirrors the AI SDK's completion predicate, inverted: the SDK drops to
 * status "ready" between agentic steps (stream ended, tools executing), so
 * `isBusy` derived from status alone makes the turn look stopped and
 * restarted. This closes that gap from the messages the SDK already exposes.
 *
 * `input-streaming` parts are excluded: the SDK only dispatches an execution
 * when the tool input becomes available, so a part aborted mid-input never
 * had an execution started and no output will ever arrive — counting it
 * would hold `isBusy` true forever. While the stream is live, `status`
 * already covers busy for these parts.
 *
 * `loadedMessageIds` skips messages restored from storage: their tool
 * executions died with the old process, so a pending part persisted by an
 * interrupt-and-quit would otherwise hold `isBusy` true forever. In a live
 * session the interrupted message id is never in the set, so the busy
 * indicator still covers the in-flight executions until they land.
 */
export const hasPendingToolExecutionStep = (
	messages: CodingAgentUIMessage[],
	loadedMessageIds?: ReadonlySet<string>
): boolean => {
	const message = messages.at(-1);
	if (!message || message.role !== "assistant") {
		return false;
	}
	if (loadedMessageIds?.has(message.id)) {
		return false;
	}
	const lastStepStartIndex = message.parts.reduce(
		(lastIndex, part, index) =>
			part.type === "step-start" ? index : lastIndex,
		-1
	);
	// The same part set the SDK's completion predicate considers: static
	// `tool-*` parts plus `dynamic-tool` parts, excluding provider-executed
	// calls and never-dispatched input-streaming parts. Any dispatched call
	// that has not reached a terminal output state means the turn is still
	// running while the SDK reports status "ready".
	const lastStepToolCalls = message.parts
		.slice(lastStepStartIndex + 1)
		.filter(isToolUIPart)
		.filter((part) => !part.providerExecuted)
		.filter((part) => part.state !== "input-streaming");
	return lastStepToolCalls.some(
		(part) => !isTerminalToolOutputState(part.state)
	);
};

/**
 * The settled outcome of submitting a chat prompt. Explicit Skill rejection
 * resolves with `{ rejected: true }` so the caller can preserve the input and
 * attachments without sending a prompt.
 */
export type SubmitChatOutcome =
	| { readonly rejected: false }
	| { readonly rejected: true; readonly reason: string };

type MutableRefObject<T> = { current: T };

const isCodingToolName = (name: string): name is CodingToolName =>
	codingToolNames.some((tool) => tool === name);

const emitToolCallError = (
	addToolOutput: ChatAddToolOutputFunction<CodingAgentUIMessage>,
	tool: CodingToolName,
	toolCallId: string,
	errorText: string
): void => {
	Promise.resolve(
		addToolOutput({
			errorText,
			state: "output-error",
			tool,
			toolCallId,
		})
	).catch(() => undefined);
};

const emitDynamicToolCallError = (
	addToolOutput: McpAddToolOutput,
	tool: string,
	toolCallId: string,
	errorText: string
): void => {
	Promise.resolve(
		addToolOutput({ errorText, state: "output-error", tool, toolCallId })
	).catch(() => undefined);
};

type ChatToolCallHandlerCommonDeps = {
	addToolOutputRef: MutableRefObject<ChatAddToolOutputFunction<CodingAgentUIMessage> | null>;
	dynamicToolOutputRef: MutableRefObject<McpAddToolOutput | null>;
	handleCodingAgentToolCall?: typeof handleCodingAgentToolCall;
	mcp: Pick<McpContextValue, "handleDynamicToolCall">;
	mcpSnapshotRef: MutableRefObject<McpCatalogSnapshot | null>;
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>;
	skillExecutionRef?: MutableRefObject<SkillExecution | null>;
	gate: ToolGate;
};

export type ChatToolCallHandlerDeps = ChatToolCallHandlerCommonDeps;

/**
 * Dispatches AI SDK tool calls to the MCP handler for dynamic tools, to the
 * Skill Activation runner for the native `skill` tool, and to the coding-agent
 * handler otherwise. The AI SDK awaits `onToolCall`, but `addToolOutput`
 * queues on the same chat executor, so neither promise is returned or awaited
 * here or tool execution deadlocks at input-available.
 */
export const createChatToolCallHandler = (
	deps: ChatToolCallHandlerDeps
): ChatOnToolCallCallback<CodingAgentUIMessage> => {
	const {
		addToolOutputRef,
		dynamicToolOutputRef,
		handleCodingAgentToolCall: runStaticToolCall = handleCodingAgentToolCall,
		mcp,
		mcpSnapshotRef,
		resolvedAgentRef,
		skillExecutionRef,
		gate,
	} = deps;
	return (options) => {
		const addToolOutput = addToolOutputRef.current;

		if (!addToolOutput) {
			return;
		}
		if (options.toolCall.toolName === "skill") {
			// The `skill` tool is declared as a dynamic tool on the model loop but
			// executed entirely in the CLI, so it is intercepted before the MCP
			// dispatch below.
			const skillAddToolOutput = dynamicToolOutputRef.current;
			if (!skillAddToolOutput) {
				return;
			}
			Promise.resolve(
				(async () => {
					await runSkillToolCall({
						addToolOutput: skillAddToolOutput,
						executionRef: skillExecutionRef,
						gate,
						toolCall: {
							input: options.toolCall.input,
							toolCallId: options.toolCall.toolCallId,
						},
					});
				})()
			).catch(() => {
				emitDynamicToolCallError(
					skillAddToolOutput,
					"skill",
					options.toolCall.toolCallId,
					"Skill Activation failed"
				);
			});
			return;
		}

		if (options.toolCall.dynamic) {
			// The AI SDK types addToolOutput for static coding tools, but dynamic
			// MCP tools carry arbitrary names; runtime matching is by toolCallId,
			// so bridge the type here.
			const mcpAddToolOutput = dynamicToolOutputRef.current;
			if (!mcpAddToolOutput) {
				return;
			}
			Promise.resolve(
				mcp.handleDynamicToolCall(
					mcpSnapshotRef.current,
					options.toolCall,
					mcpAddToolOutput,
					(tool, input, toolCallId) =>
						gate.gate({
							action: tool.logicalName,
							agentDecision: tool.agentDecision,
							description: tool.description,
							family: "mcp",
							input,
							safety: tool.safety,
							serverDecision: tool.serverDecision,
							toolCallId,
							toolName: options.toolCall.toolName,
						})
				)
			).catch(() => {
				emitDynamicToolCallError(
					mcpAddToolOutput,
					options.toolCall.toolName,
					options.toolCall.toolCallId,
					"MCP tool call failed"
				);
			});
			return;
		}

		if (options.toolCall.toolName === "shell") {
			// Shell is a static coding tool with its own gate: the command is the
			// evaluated resource, `cwd` composes the external-directory boundary,
			// and destructive commands raise the safety ceiling. It is intercepted
			// before the shared static gate because its inputs carry no path to
			// resolve and its always-approval grants `shell *`.
			Promise.resolve(
				(async () => {
					const outcome = await gate.gate({
						family: "shell",
						toolCall: options.toolCall,
					});
					if (outcome.kind === "allow") {
						await runStaticToolCall(
							addToolOutput,
							resolvedAgentRef.current?.visibleCodingTools ?? []
						)(options);
						return;
					}
					emitToolCallError(
						addToolOutput,
						"shell",
						options.toolCall.toolCallId,
						outcome.errorText ?? "Shell tool call was blocked"
					);
				})()
			).catch(() => {
				emitToolCallError(
					addToolOutput,
					"shell",
					options.toolCall.toolCallId,
					"Shell tool call failed"
				);
			});
			return;
		}

		if (!isCodingToolName(options.toolCall.toolName)) {
			return;
		}
		const toolName = options.toolCall.toolName;

		Promise.resolve(
			(async () => {
				const outcome = await gate.gate({
					family: "coding",
					toolCall: options.toolCall,
				});
				if (outcome.kind !== "allow") {
					emitToolCallError(
						addToolOutput,
						toolName,
						options.toolCall.toolCallId,
						outcome.errorText ?? "Tool call was blocked"
					);
					return;
				}
				await runStaticToolCall(
					addToolOutput,
					resolvedAgentRef.current?.visibleCodingTools ?? []
				)(options);
			})()
		).catch(() => {
			emitToolCallError(
				addToolOutput,
				toolName,
				options.toolCall.toolCallId,
				"Tool call failed"
			);
		});
	};
};

export type SkillToolCallDeps = {
	addToolOutput: McpAddToolOutput;
	executionRef?: MutableRefObject<SkillExecution | null>;
	gate: ToolGate;
	toolCall: { input?: unknown; toolCallId: string };
};

const emitSkillToolResult = (
	addToolOutput: McpAddToolOutput,
	toolCallId: string,
	result: SkillToolResult
): void | PromiseLike<void> =>
	addToolOutput({
		output: result,
		state: "output-available",
		tool: "skill",
		toolCallId,
	});

/**
 * Executes one Agent-driven `skill` tool call entirely in the CLI: the Skill is
 * looked up in the execution-turn catalog, its `skill` Permission decision is
 * evaluated (an `ask` goes through the shared approval dialog), and the body
 * snapshot is activated within the three-Skill limit. Rejected and failed
 * loads consume no slot, a rejected Skill cannot be retried in the same
 * execution, and the emitted result is the live payload for the model loop —
 * durable state sanitizes it separately.
 */
export const runSkillToolCall = async ({
	addToolOutput,
	executionRef,
	gate,
	toolCall,
}: SkillToolCallDeps): Promise<void> => {
	const execution = executionRef?.current ?? null;
	if (!execution) {
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			error: "Skill Activation is not active for this turn",
			name: "",
			status: "failed",
		});
		return;
	}
	const input = skillToolInputSchema.safeParse(toolCall.input);
	if (!input.success) {
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			error: "Invalid skill input; expected { name }",
			name: "",
			status: "failed",
		});
		return;
	}
	const name = input.data.name;

	// The policy is evaluated before the catalog lookup so a denied Skill —
	// hidden from the catalog by design — settles as rejected, not failed.
	const entry = execution.catalog.entries.find(
		({ name: entryName }) => entryName === name
	);
	const outcome = await gate.gate({
		available: entry !== undefined,
		description: entry?.description ?? `Activate Skill ${name}`,
		family: "skill",
		name,
		toolCallId: toolCall.toolCallId,
	});
	if (outcome.kind !== "allow") {
		execution.markRejected(name);
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			name,
			status: "rejected",
		});
		return;
	}

	if (!entry) {
		const result = execution.activate(name, "agent");
		await emitSkillToolResult(
			addToolOutput,
			toolCall.toolCallId,
			resultToToolResult(result)
		);
		return;
	}

	const result = execution.activate(name, "agent");
	if (result.status === "loaded") {
		const resourcePaths = await sampleSkillResources(
			result.snapshot.baseDirectory
		);
		execution.setResourceSample(name, resourcePaths);
		await emitSkillToolResult(addToolOutput, toolCall.toolCallId, {
			baseDirectory: result.snapshot.baseDirectory,
			body: result.snapshot.body,
			contentHash: result.snapshot.contentHash,
			name,
			resourcePaths,
			source: "agent",
			status: "loaded",
		});
		return;
	}
	await emitSkillToolResult(addToolOutput, toolCall.toolCallId, result);
};

const resultToToolResult = (result: SkillActivationResult): SkillToolResult => {
	if (result.status === "loaded") {
		return {
			baseDirectory: result.snapshot.baseDirectory,
			body: result.snapshot.body,
			contentHash: result.snapshot.contentHash,
			name: result.snapshot.name,
			resourcePaths: result.snapshot.resourcePaths,
			source: result.snapshot.source,
			status: "loaded",
		};
	}
	if (result.status === "already-loaded") {
		return {
			contentHash: result.contentHash,
			name: result.name,
			status: "already-loaded",
		};
	}
	if (result.status === "failed") {
		return { error: result.error, name: result.name, status: "failed" };
	}
	if (result.status === "limit-reached") {
		return {
			activeSkillNames: result.activeSkillNames,
			limit: result.limit,
			name: result.name,
			status: "limit-reached",
		};
	}
	return { name: result.name, status: "rejected" };
};

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
	// Rebuild the conversation-scoped gate when its conversation or authorization
	// dependencies change, rejecting pending requests from the previous scope.
	const toolGateState = useMemo(() => {
		const approvalQueue = createApprovalQueue<ToolApprovalRequest>();
		return {
			approvalQueue,
			gate: createToolGate({
				approvalQueue,
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

		setMessagesRef.current?.(nextMessages);
		persistMessages(nextMessages);
		chat.stop();
	};

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
	}: SubmitChatParams): Promise<SubmitChatOutcome> => {
		autoSendGate.enable();
		agentRef.current = agent;
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();

		await createTurnSkillExecution();
		let explicitSkill: SkillRequestContext | undefined;
		if (skill) {
			const execution = skillExecutionRef.current;
			if (execution === null) {
				return { rejected: true, reason: "Skill catalog is unavailable" };
			}
			const activation = await activateExplicitSkill(skill, {
				execution,
				gate: toolGate,
			});
			if (!activation.ok) {
				return { rejected: true, reason: activation.reason };
			}
			explicitSkill = activation.skill;
		}

		const metadata = {
			agent,
			model,
			variant,
			...(explicitSkill
				? { skill: createSkillSnapshot(explicitSkill, "explicit") }
				: {}),
		};
		const optimisticMessage = createUserMessage(userText, metadata, [], files);
		chat.setMessages((messages) => [
			...sanitizeSkillToolParts(messages),
			optimisticMessage,
		]);
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
			chat.setMessages((messages) =>
				messages.filter(({ id }) => id !== optimisticMessage.id)
			);
			throw error;
		} finally {
			setIsPreparingMessage(false);
		}
	};

	const continueLastMessage = async (
		agent: AgentId,
		model: ChatModelSelection,
		variant?: ModelVariant,
		resolvedAgent?: ResolvedAgentRuntime,
		conversationModel: ChatModelSelection = model,
		conversationVariant: ModelVariant | undefined = variant
	): Promise<SubmitChatOutcome> => {
		autoSendGate.enable();
		agentRef.current = agent;
		resolvedAgentRef.current = resolvedAgent;
		conversationModelRef.current = conversationModel;
		conversationVariantRef.current = conversationVariant;
		modelRef.current = model;
		variantRef.current = variant;
		requestStartedAtRef.current = Date.now();

		// A retry or auto-start is a new execution: permissions and Skill
		// contents are re-evaluated from current state.
		await createTurnSkillExecution();

		// A session created with an explicit Skill (for example the initial
		// command-line prompt) or retried after an interruption carries Skill
		// metadata on its user message — sanitized activation metadata after a
		// reload, the full snapshot in memory. Either way the Skill is
		// re-authorized and re-snapshotted from current content, and the user
		// message metadata is refreshed so the transport injects the live body.
		const originatingUserMessage = [...chat.messages]
			.reverse()
			.find(({ role }) => role === "user");
		const parsedSkill = codingMessageSkillSchema.safeParse(
			originatingUserMessage?.metadata?.skill
		);
		if (parsedSkill.success) {
			const execution = skillExecutionRef.current;
			if (execution !== null) {
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
					return { rejected: true, reason: activation.reason };
				}
				chat.setMessages((messages) =>
					messages.map((message) =>
						message.id === originatingUserMessage?.id
							? {
									...message,
									metadata: {
										...message.metadata,
										skill: createSkillSnapshot(activation.skill, "explicit"),
									},
								}
							: message
					)
				);
			}
		}

		chat.setMessages((messages) => sanitizeSkillToolParts(messages));
		await chat.sendMessage();
		return { rejected: false };
	};

	return {
		abort: chat.stop,
		catalogDiagnostic,
		continueLastMessage,
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

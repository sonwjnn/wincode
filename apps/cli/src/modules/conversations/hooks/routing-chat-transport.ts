import type { ConversationRecord } from "@wincode/agent-core";
import { type AgentTurn, createAgentTurnId } from "@wincode/agent-core";
import type {
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
} from "@wincode/ai";
import { createUserMessage } from "@wincode/ai/client";
import type { SkillExecution, SkillToolDefinition } from "@wincode/skills";
import type { ChatTransport } from "ai";
import type { MutableRefObject } from "react";
import type { AgentRegistry } from "@/modules/agents";
import { prepareAgentCall } from "@/modules/agents";
import type { Connections } from "@/modules/connections";
import type { McpContextValue } from "@/modules/mcp";
import { resolveChatModelTarget } from "../../model-target";
import type { ConversationViewState } from "../conversation-controller";
import type { AttachmentHydrationOptions } from "../storage/attachment-store";
import { getConversationStore } from "../storage/get-conversation-store";
import {
	createLocalChatTransport,
	delegationFromBody,
} from "./local-chat-transport";
import type {
	DelegationExecutor,
	DelegationRequest,
	RuntimeGatedTooling,
} from "./runtime-turn";
import {
	buildAgentTurn,
	createGatedCodingTools,
	defaultRuntimeFactory,
	runAgentTurnToText,
} from "./runtime-turn";

type AttachmentModelBudget = Pick<
	AttachmentHydrationOptions,
	"maxAttachments" | "maxBytes" | "maxTokens"
>;
const toolCallIdOf = (
	call: Parameters<RuntimeGatedTooling["gate"]["gate"]>[0]
): string | undefined => {
	if (call.family === "coding" || call.family === "shell") {
		return call.toolCall.toolCallId;
	}
	return call.toolCallId;
};

export const createDelegationExecutor = (
	sessionId: string,
	registry: AgentRegistry | null,
	connections: Connections,
	mcp: McpContextValue,
	fallbackModelRef: MutableRefObject<ChatModelSelection>,
	fallbackVariantRef: MutableRefObject<ModelVariant | undefined>,
	gatedTooling: RuntimeGatedTooling,
	createSkillContext?: (agent: AgentId) => Promise<
		| {
				execution: SkillExecution;
				tool: SkillToolDefinition;
		  }
		| undefined
	>,
	onViewState?: (state: ConversationViewState | undefined) => void
): DelegationExecutor => {
	let activeChildCount = 0;
	const clearChildView = (): void => {
		activeChildCount = Math.max(0, activeChildCount - 1);
		// Sibling children may still be streaming; only the last one to
		// settle clears the shared projection.
		if (activeChildCount === 0) {
			onViewState?.(undefined);
		}
	};
	return async (request: DelegationRequest, signal) => {
		activeChildCount += 1;
		const childController = new AbortController();
		const childSignal =
			signal === undefined
				? childController.signal
				: AbortSignal.any([signal, childController.signal]);
		let mcpSnapshot:
			| Awaited<ReturnType<McpContextValue["createSnapshot"]>>
			| undefined;
		try {
			const target = registry?.agents.find(
				({ id, isAvailable, role }) =>
					id === request.agent &&
					isAvailable &&
					(role === "subagent" || role === "all")
			);
			if (target === undefined) {
				throw new Error(`Delegation target '${request.agent}' is unavailable.`);
			}
			const prepared = prepareAgentCall(
				registry,
				{
					agent: target.id,
					model: fallbackModelRef.current,
					variant: fallbackVariantRef.current,
				},
				{ allowSubagent: true }
			);
			const modelTarget = await resolveChatModelTarget(
				prepared.model,
				connections,
				{
					signal: childSignal,
					variant: prepared.variant,
				}
			);
			mcpSnapshot = await mcp.createSnapshot(prepared.agent, undefined, false);
			const executeMcpTool =
				mcp.execute === undefined
					? undefined
					: async (
							snapshot: NonNullable<typeof mcpSnapshot>,
							toolName: string,
							input: unknown,
							toolSignal?: AbortSignal
						) => {
							const result = await mcp.execute?.(
								snapshot,
								toolName,
								input,
								toolSignal
							);
							return result?.isError
								? {
										errorText: "MCP tool call failed.",
										type: "failure" as const,
									}
								: { output: result, type: "success" as const };
						};
			const childGate = {
				gate: async (
					call: Parameters<RuntimeGatedTooling["gate"]["gate"]>[0]
				) => {
					const toolCallId = toolCallIdOf(call);
					const unregister =
						toolCallId === undefined
							? undefined
							: gatedTooling.registerChildAbort?.(toolCallId, () =>
									childController.abort("approval-abort")
								);
					try {
						return await gatedTooling.gate.gate(call);
					} finally {
						unregister?.();
					}
				},
			};
			const skillContext = await createSkillContext?.(prepared.agent);
			const turnId = createAgentTurnId();
			const turn: AgentTurn = buildAgentTurn({
				agent: prepared.agent,
				delegation: {
					parentToolCallId: request.parentToolCallId,
					parentTurnId: request.parentTurnId,
				},
				modelMessages: [createUserMessage(request.prompt)],
				modelTarget,
				resolvedAgent: prepared.resolvedAgent,
				tools: createGatedCodingTools({
					agentId: prepared.agent,
					agentTools: prepared.resolvedAgent.visibleCodingTools,
					delegate: gatedTooling.delegate,
					executeMcpTool,
					gate: childGate,
					mcpSnapshot,
					skillExecution: skillContext?.execution,
					skillTool: skillContext?.tool,
					parentTurnId: turnId,
					resolveResourceLimits: gatedTooling.resolveResourceLimits,
				}),
				turnId,
			});
			return await runAgentTurnToText({
				onCheckpoint: (record) =>
					getConversationStore().commitConversationRecord({
						record,
						sessionId,
					}),
				onViewState,
				runtime: defaultRuntimeFactory(),
				signal: childSignal,
				turn,
			});
		} finally {
			if (mcpSnapshot !== undefined) {
				mcp.releaseSnapshot?.(mcpSnapshot);
			}
			clearChildView();
		}
	};
};

export const createRoutingChatTransport = (
	sessionId: string,
	agentRef: MutableRefObject<AgentId>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	registry: AgentRegistry | null,
	connections: Connections,
	mcp: McpContextValue,
	skillToolRef?: MutableRefObject<SkillToolDefinition | undefined>,
	attachmentBudgetRef?: MutableRefObject<AttachmentModelBudget | undefined>,
	outcomeSignalRef?: MutableRefObject<AbortSignal | undefined>,
	gatedToolingRef?: MutableRefObject<RuntimeGatedTooling | undefined>,
	skillExecutionRef?: MutableRefObject<SkillExecution | null>,
	onViewState?: (state: ConversationViewState) => void,
	delegationExecutor?: DelegationExecutor
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async (options) => {
		const delegation = delegationFromBody(options.body);
		const prepared = prepareAgentCall(
			registry,
			{
				agent: agentRef.current,
				model: modelRef.current,
				variant: variantRef.current,
			},
			{ allowSubagent: delegation !== undefined }
		);
		const snapshot = await mcp.createSnapshot(prepared.agent);
		const messages = await getConversationStore().hydrateAttachments(
			options.messages,
			{
				purpose: "model",
				priorityMessageId: options.messages.findLast(
					({ role }) => role === "user"
				)?.id,
				signal: options.abortSignal,
				...(attachmentBudgetRef?.current ?? {}),
			}
		);
		return createLocalChatTransport(
			sessionId,
			{ current: prepared.resolvedAgent },
			modelRef,
			variantRef,
			connections,
			undefined,
			snapshot,
			skillToolRef,
			agentRef.current,
			undefined,
			(record: ConversationRecord) =>
				getConversationStore().commitConversationRecord({
					record,
					sessionId,
				}),
			outcomeSignalRef,
			gatedToolingRef?.current === undefined
				? undefined
				: {
						...gatedToolingRef.current,
						...(delegationExecutor === undefined
							? {}
							: { delegate: delegationExecutor }),
					},
			skillExecutionRef,
			onViewState
		).sendMessages({ ...options, messages });
	},
	reconnectToStream: async () => null,
});

import type { AgentId, AgentTurn } from "@wincode/agent-core";
import { createAgentTurnId } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { SkillExecution, SkillToolDefinition } from "@wincode/skills";
import type { AgentRegistry } from "@/modules/agents";
import { prepareAgentCall } from "@/modules/agents";
import type { Connections } from "@/modules/connections";
import type { McpCatalogSnapshot, McpContextValue } from "@/modules/mcp";
import { resolveChatModelTarget } from "../../model-target";
import type { ConversationViewState } from "../conversation-controller";
import { createConversationUserMessage } from "../message";
import { getConversationStore } from "../storage/get-conversation-store";
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

type MutableRefObject<T> = { current: T };

type ChildSkillContextFactory = (agent: AgentId) => Promise<
	| {
			execution: SkillExecution;
			tool: SkillToolDefinition;
	  }
	| undefined
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
	createSkillContext?: ChildSkillContextFactory,
	onViewState?: (state: ConversationViewState | undefined) => void
): DelegationExecutor => {
	let activeChildCount = 0;
	const clearChildView = (): void => {
		activeChildCount = Math.max(0, activeChildCount - 1);
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
		let snapshot: McpCatalogSnapshot | undefined;
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
					...(prepared.variant === undefined
						? {}
						: { variant: prepared.variant }),
				}
			);
			snapshot = await mcp.createSnapshot(prepared.agent, undefined, false);
			const executeMcpTool =
				mcp.execute === undefined
					? undefined
					: async (
							currentSnapshot: NonNullable<typeof snapshot>,
							toolName: string,
							input: unknown,
							toolSignal?: AbortSignal
						) => {
							const result = await mcp.execute?.(
								currentSnapshot,
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
			const childGate: RuntimeGatedTooling = {
				...gatedTooling,
				gate: {
					gate: async (call) => {
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
				modelMessages: [createConversationUserMessage(request.prompt)],
				modelTarget,
				resolvedAgent: prepared.resolvedAgent,
				tools: createGatedCodingTools({
					agentId: prepared.agent,
					agentTools: prepared.resolvedAgent.visibleCodingTools,
					delegate: gatedTooling.delegate,
					executeMcpTool,
					gate: childGate.gate,
					mcpSnapshot: snapshot,
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
			if (snapshot !== undefined) {
				mcp.releaseSnapshot?.(snapshot);
			}
			clearChildView();
		}
	};
};

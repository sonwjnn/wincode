import type { AgentId, AgentTurn } from "@wincode/agent-core";
import { createAgentTurnId } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { SkillExecution, SkillToolDefinition } from "@wincode/skills";
import type { AgentRegistry } from "@/modules/agents";
import { prepareAgentCall } from "@/modules/agents";
import type { Connections } from "@/modules/connections";
import {
	createMcpToolExecutor,
	type McpAgentPolicy,
	type McpCatalogSnapshot,
	type McpContextValue,
} from "@/modules/mcp";
import { resolveChatModelTarget } from "../../model-target";
import type { ConversationViewState } from "../conversation-controller";
import { createConversationUserMessage } from "../message";
import { buildUserConversationRecord } from "../storage/conversation-record";
import { getConversationStore } from "../storage/get-conversation-store";
import type {
	DelegationExecutor,
	DelegationRequest,
	RuntimeGatedTooling,
} from "./runtime-turn";
import {
	buildAgentTurn,
	buildAssistantFailureConversationRecord,
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

export type CreateDelegationExecutorOptions = {
	readonly connections: Connections;
	readonly createSkillContext?: ChildSkillContextFactory;
	readonly fallbackModelRef: MutableRefObject<ChatModelSelection>;
	readonly fallbackVariantRef: MutableRefObject<ModelVariant | undefined>;
	readonly gatedTooling: RuntimeGatedTooling;
	readonly mcp: McpContextValue;
	readonly onViewState?: (state: ConversationViewState | undefined) => void;
	readonly registry: AgentRegistry | null;
	readonly resolveMcpPolicyForAgent: (
		agent: AgentId
	) => Promise<McpAgentPolicy>;
	readonly sessionId: string;
};

export const createDelegationExecutor = ({
	connections,
	createSkillContext,
	fallbackModelRef,
	fallbackVariantRef,
	gatedTooling,
	mcp,
	onViewState,
	registry,
	resolveMcpPolicyForAgent,
	sessionId,
}: CreateDelegationExecutorOptions): DelegationExecutor => {
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
		const turnId = createAgentTurnId();
		const delegation = {
			parentToolCallId: request.parentToolCallId,
			parentTurnId: request.parentTurnId,
		};
		const userMessage = createConversationUserMessage(request.prompt);
		const store = getConversationStore();
		let selectedAgent = request.agent;
		let selectedModel = fallbackModelRef.current;
		let selectedVariant = fallbackVariantRef.current;
		let userCommitted = false;
		let terminalObserved = false;
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
			selectedAgent = prepared.agent;
			selectedModel = prepared.model;
			selectedVariant = prepared.variant;
			await store.commitConversationRecord({
				record: buildUserConversationRecord({
					agentId: selectedAgent,
					delegation,
					message: userMessage,
					model: selectedModel,
					turnId,
					variant: selectedVariant,
				}),
				sessionId,
			});
			userCommitted = true;
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
			const mcpPolicy = await resolveMcpPolicyForAgent(prepared.agent);
			snapshot = await mcp.createSnapshot(prepared.agent, mcpPolicy, false);
			const executeMcpTool = createMcpToolExecutor(mcp.execute);
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
			const turn: AgentTurn = buildAgentTurn({
				agent: prepared.agent,
				delegation,
				modelMessages: [userMessage],
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
					store.commitConversationRecord({
						record,
						sessionId,
					}),
				onTerminal: () => {
					terminalObserved = true;
				},
				onToolCheckpoint: (record) =>
					store.commitConversationRecord({
						record,
						sessionId,
					}),
				onViewState,
				runtime: defaultRuntimeFactory(),
				signal: childSignal,
				turn,
			});
		} catch (error) {
			if (userCommitted && !terminalObserved) {
				await store
					.commitConversationRecord({
						record: buildAssistantFailureConversationRecord({
							agentId: selectedAgent,
							delegation,
							error,
							model: selectedModel,
							turnId,
							variant: selectedVariant,
						}),
						sessionId,
					})
					.catch(() => undefined);
			}
			throw error;
		} finally {
			if (snapshot !== undefined) {
				mcp.releaseSnapshot?.(snapshot);
			}
			clearChildView();
		}
	};
};

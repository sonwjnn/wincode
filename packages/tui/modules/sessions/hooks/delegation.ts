import type {
	AgentId,
	AgentTurn,
	AgentTurnDelegation,
} from "@wincode/agent-core";
import { createAgentTurnId } from "@wincode/agent-core";
import type { ModelTarget } from "@wincode/ai/model";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { SkillExecution, SkillToolDefinition } from "@wincode/skills";
import {
	type AgentRegistry,
	type PreparedAgentCall,
	prepareAgentCall,
} from "@/modules/agents";
import type { Connections } from "@/modules/connections";
import {
	createMcpToolExecutor,
	type McpAgentPolicy,
	type McpCatalogSnapshot,
	type McpContextValue,
	type McpToolCallExecutor,
} from "@/modules/mcp";
import type { ToolPermission } from "@/modules/permissions";
import { assembleAgentTurnPrompt } from "@/modules/prompt-assembly/composer";
import { resolveChatModelTarget } from "../../model-target";
import { createSessionUserMessage, type SessionMessage } from "../message";
import type { SessionViewState } from "../session-controller";
import { getSessionStore } from "../storage/get-session-store";
import { buildUserSessionRecord } from "../storage/session-record";
import type {
	DelegationExecutor,
	DelegationRequest,
	RuntimeGatedTooling,
} from "./runtime-turn";
import {
	buildAgentTurn,
	buildAssistantFailureSessionRecord,
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

const createChildGate = (
	gatedTooling: RuntimeGatedTooling,
	childController: AbortController
): RuntimeGatedTooling => ({
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
});

type BuildChildTurnOptions = {
	readonly childGate: RuntimeGatedTooling;
	readonly createSkillContext?: ChildSkillContextFactory;
	readonly cwd?: string;
	readonly delegation: AgentTurnDelegation;
	readonly executeMcpTool: McpToolCallExecutor | undefined;
	readonly resolvePermissionForAgent?: (
		agent: AgentId
	) => Promise<ToolPermission>;
	readonly snapshot: McpCatalogSnapshot;
	readonly turnId: string;
	readonly userMessage: SessionMessage;
	readonly workspace: string;
	readonly modelTarget: ModelTarget;
	readonly prepared: PreparedAgentCall;
};

const buildChildTurn = async ({
	childGate,
	createSkillContext,
	cwd,
	delegation,
	executeMcpTool,
	modelTarget,
	prepared,
	resolvePermissionForAgent,
	snapshot,
	turnId,
	userMessage,
	workspace,
}: BuildChildTurnOptions): Promise<AgentTurn> => {
	const skillContext = await createSkillContext?.(prepared.agent);
	const tools = createGatedCodingTools({
		agentId: prepared.agent,
		agentTools: prepared.resolvedAgent.visibleCodingTools,
		delegate: childGate.delegate,
		executeMcpTool,
		gate: childGate.gate,
		mcpSnapshot: snapshot,
		skillExecution: skillContext?.execution,
		skillTool: skillContext?.tool,
		parentTurnId: turnId,
		resolveResourceLimits: childGate.resolveResourceLimits,
	});
	const childPermission = await resolvePermissionForAgent?.(prepared.agent);
	const prompt = await assembleAgentTurnPrompt({
		agent: prepared.resolvedAgent,
		cwd,
		delegation,
		mcpTools: snapshot.tools,
		model: {
			modelId: modelTarget.modelId,
			providerId: modelTarget.providerId,
		},
		permission: childPermission,
		tools,
		workspace,
	});
	return buildAgentTurn({
		agent: prepared.agent,
		delegation,
		modelMessages: [userMessage],
		modelTarget,
		resolvedAgent: prepared.resolvedAgent,
		systemInstructions: prompt.instructions,
		tools,
		turnId,
	});
};

export type CreateDelegationExecutorOptions = {
	readonly connections: Connections;
	readonly createSkillContext?: ChildSkillContextFactory;
	readonly cwd?: string;
	readonly fallbackModelRef: MutableRefObject<ChatModelSelection>;
	readonly fallbackVariantRef: MutableRefObject<ModelVariant | undefined>;
	readonly gatedTooling: RuntimeGatedTooling;
	readonly mcp: McpContextValue;
	readonly onViewState?: (state: SessionViewState | undefined) => void;
	readonly registry: AgentRegistry | null;
	readonly resolveMcpPolicyForAgent: (
		agent: AgentId
	) => Promise<McpAgentPolicy>;
	readonly resolvePermissionForAgent?: (
		agent: AgentId
	) => Promise<ToolPermission>;
	readonly sessionId: string;
	readonly workspace: string;
};

export const createDelegationExecutor = ({
	connections,
	createSkillContext,
	cwd,
	fallbackModelRef,
	fallbackVariantRef,
	gatedTooling,
	mcp,
	onViewState,
	registry,
	resolveMcpPolicyForAgent,
	resolvePermissionForAgent,
	sessionId,
	workspace,
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
		const userMessage = createSessionUserMessage(request.prompt);
		const store = getSessionStore();
		let selectedAgent = request.agent;
		let selectedModel = fallbackModelRef.current;
		let selectedVariant = fallbackVariantRef.current;
		let userCommitted = false;
		let userCommitAttempted = false;
		const commitUserMessage = async (): Promise<void> => {
			userCommitAttempted = true;
			await store.commitSessionRecord({
				record: buildUserSessionRecord({
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
		};
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
			await commitUserMessage();
			const modelTarget = await resolveChatModelTarget(
				prepared.model,
				connections,
				{
					allowRetired: true,
					signal: childSignal,
					...(prepared.variant === undefined
						? {}
						: { variant: prepared.variant }),
				}
			);
			const mcpPolicy = await resolveMcpPolicyForAgent(prepared.agent);
			snapshot = await mcp.createSnapshot(prepared.agent, mcpPolicy, false);
			const executeMcpTool = createMcpToolExecutor(mcp.execute);
			const childGate = createChildGate(gatedTooling, childController);
			const turn = await buildChildTurn({
				childGate,
				createSkillContext,
				cwd,
				delegation,
				executeMcpTool,
				modelTarget,
				prepared,
				resolvePermissionForAgent,
				snapshot,
				turnId,
				userMessage,
				workspace,
			});
			return await runAgentTurnToText({
				onCheckpoint: (record) =>
					store.commitSessionRecord({
						record,
						sessionId,
					}),
				onTerminal: () => {
					terminalObserved = true;
				},
				onToolCheckpoint: (record) =>
					store.commitSessionRecord({
						record,
						sessionId,
					}),
				onViewState,
				runtime: defaultRuntimeFactory(),
				signal: childSignal,
				sourceUserMessageId: userMessage.id,
				turn,
			});
		} catch (error) {
			if (!(userCommitted || userCommitAttempted)) {
				await commitUserMessage();
			}
			if (userCommitted && !terminalObserved) {
				await store
					.commitSessionRecord({
						record: buildAssistantFailureSessionRecord({
							agentId: selectedAgent,
							delegation,
							error,
							model: selectedModel,
							sourceUserMessageId: userMessage.id,
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

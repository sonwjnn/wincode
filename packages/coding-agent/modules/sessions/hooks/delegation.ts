import {
	type AgentId,
	type AgentTurn,
	type AgentTurnDelegation,
	type AgentTurnId,
	createAgentTurnId,
	type ToolCallId,
} from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import type { ModelTarget } from "@wincode/ai/model";
import { isUndefined, omitUndefined } from "@wincode/runtime-utils";
import {
	type AgentCallSelection,
	type PreparedAgentCall,
	prepareAgentCall,
} from "@/modules/agents/agent-call";
import type { AgentRegistry } from "@/modules/agents/registry";
import type { McpSessionCapability } from "@/modules/mcp/capability";
import type {
	McpAgentPolicy,
	McpCatalogSnapshot,
} from "@/modules/mcp/registry";
import {
	createMcpToolExecutor,
	type McpToolCallExecutor,
} from "@/modules/mcp/result";
import type { ToolPermission } from "@/modules/permissions/policy";
import { prepareAgentTurnPrompt } from "@/modules/prompt-composition/composer";
import type { SessionId } from "@/shared/identifiers";
import { resolveChatModelTarget } from "../../model-target";
import type { SessionCommitInput } from "../agent-session/types";
import { createSessionUserMessage, type SessionMessage } from "../message";
import { buildUserSessionRecord } from "../storage/session-record";
import type {
	BeginTurnExecutionInput,
	TurnExecution,
	TurnExecutionHost,
	TurnExecutionSkill,
} from "../turn-execution";
import { buildAssistantFailureSessionRecord } from "../turn-records";
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

type ChildSkillContextFactory = (
	agent: AgentId
) => Promise<TurnExecutionSkill | undefined>;

const toolCallIdOf = (
	call: Parameters<RuntimeGatedTooling["gate"]["gate"]>[0]
): ToolCallId | undefined => {
	if (call.family === "coding" || call.family === "shell") {
		return call.toolCall.toolCallId;
	}
	return call.toolCallId;
};

/**
 * Registers a delegated execution's in-flight Tool Calls in the spawning
 * execution's abort index while their Gate evaluation is pending, so an
 * approval abort cancels the Subagent that owes the call instead of the
 * execution that spawned it.
 */
const createChildGate = (
	gatedTooling: RuntimeGatedTooling,
	childController: AbortController
): RuntimeGatedTooling["gate"] => ({
	gate: async (call) => {
		const toolCallId = toolCallIdOf(call);
		const unregister = isUndefined(toolCallId)
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
});

/** Routes a delegation request through the execution that owns the bookkeeping. */
export const delegationThrough =
	(execution: TurnExecution): DelegationExecutor =>
	(request, signal) => {
		const delegate = execution.delegate;
		return isUndefined(delegate)
			? Promise.reject(new Error("Delegation is unavailable."))
			: delegate(request, signal);
	};

type BuildChildTurnOptions = {
	readonly childTooling: RuntimeGatedTooling;
	readonly cwd?: string;
	readonly delegation: AgentTurnDelegation;
	readonly executeMcpTool: McpToolCallExecutor | undefined;
	readonly resolvePermissionForAgent?: (
		agent: AgentId
	) => Promise<ToolPermission>;
	readonly skill?: TurnExecutionSkill;
	readonly snapshot: McpCatalogSnapshot;
	readonly turnId: AgentTurnId;
	readonly userMessage: SessionMessage;
	readonly workspace: string;
	readonly modelTarget: ModelTarget;
	readonly prepared: PreparedAgentCall;
};

const buildChildTurn = async ({
	childTooling,
	cwd,
	delegation,
	executeMcpTool,
	modelTarget,
	prepared,
	resolvePermissionForAgent,
	skill,
	snapshot,
	turnId,
	userMessage,
	workspace,
}: BuildChildTurnOptions): Promise<AgentTurn> => {
	const tools = createGatedCodingTools({
		agentId: prepared.agent,
		agentTools: prepared.resolvedAgent.visibleCodingTools,
		delegate: childTooling.delegate,
		executeMcpTool,
		gate: childTooling.gate,
		mcpSnapshot: snapshot,
		skillExecution: skill?.execution,
		skillTool: skill?.tool,
		parentTurnId: turnId,
		resolveResourceLimits: childTooling.resolveResourceLimits,
		versionedEditing: childTooling.versionedEditing,
	});
	const childPermission = await resolvePermissionForAgent?.(prepared.agent);
	const prompt = await prepareAgentTurnPrompt({
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
	readonly commitRecord: (input: SessionCommitInput) => Promise<void>;
	readonly isShutDown: () => boolean;
	readonly connections: Connections;
	readonly createSkillContext?: ChildSkillContextFactory;
	readonly cwd?: string;
	/** The execution whose delegation bookkeeping this executor is. */
	readonly execution: TurnExecution;
	readonly host: TurnExecutionHost;
	readonly mcp: McpSessionCapability;
	readonly registry: AgentRegistry | null;
	readonly resolveMcpPolicyForAgent: (
		agent: AgentId
	) => Promise<McpAgentPolicy>;
	readonly resolvePermissionForAgent?: (
		agent: AgentId
	) => Promise<ToolPermission>;
	readonly sessionId: SessionId;
	/** The Tooling this execution's own Tool Calls execute through. */
	readonly tooling: RuntimeGatedTooling;
	readonly workspace: string;
};

/**
 * Runs one delegated Subagent execution. The execution scope, its own
 * delegation bookkeeping, and its Session View State are created when the
 * Subagent starts and dropped when it ends, so the parent keeps its view.
 */
export const createDelegationExecutor = (
	options: CreateDelegationExecutorOptions
): DelegationExecutor => {
	const {
		isShutDown,
		commitRecord,
		connections,
		createSkillContext,
		cwd,
		execution,
		host,
		mcp,
		registry,
		resolveMcpPolicyForAgent,
		resolvePermissionForAgent,
		sessionId,
		tooling,
		workspace,
	} = options;
	const assertOpen = (): void => {
		if (isShutDown()) {
			throw new Error("The session has ended.");
		}
	};

	return async (request: DelegationRequest, signal) => {
		assertOpen();
		const childController = new AbortController();
		const childSignal = isUndefined(signal)
			? childController.signal
			: AbortSignal.any([signal, childController.signal]);
		const turnId = createAgentTurnId();
		const delegation = {
			parentToolCallId: request.parentToolCallId,
			parentTurnId: request.parentTurnId,
		};
		const userMessage = createSessionUserMessage(request.prompt);
		let started: TurnExecution | undefined;
		let selectedAgent = request.agent;
		let selectedModel = execution.model;
		let selectedEffort = execution.effort;
		let selectedReasoningMode = execution.reasoningMode;
		let userCommitted = false;
		let userCommitAttempted = false;
		let terminalObserved = false;
		let snapshot: McpCatalogSnapshot | undefined;
		const commitUserMessage = async (): Promise<void> => {
			userCommitAttempted = true;
			await commitRecord({
				record: buildUserSessionRecord({
					agentId: selectedAgent,
					delegation,
					message: userMessage,
					model: selectedModel,
					turnId,
					effort: selectedEffort,
					reasoningMode: selectedReasoningMode,
				}),
				sessionId,
			});
			userCommitted = true;
		};

		/**
		 * Resolves the delegated Agent, starts the execution scope with its
		 * parent linkage, and arms its own delegation bookkeeping before the
		 * delegated prompt becomes durable.
		 */
		const startChild = async (): Promise<{
			child: TurnExecution;
			childTooling: RuntimeGatedTooling;
			prepared: PreparedAgentCall;
		}> => {
			assertOpen();
			const target = registry?.agents.find(
				({ id, isAvailable, role }) =>
					id === request.agent &&
					isAvailable &&
					(role === "subagent" || role === "all")
			);
			if (isUndefined(target)) {
				throw new Error(`Delegation target '${request.agent}' is unavailable.`);
			}
			let agentCallSelection: AgentCallSelection = {
				agent: target.id,
				model: execution.model,
			};
			if (execution.effort !== undefined) {
				agentCallSelection = {
					agent: target.id,
					effort: execution.effort,
					model: execution.model,
				};
			} else if (execution.reasoningMode !== undefined) {
				agentCallSelection = {
					agent: target.id,
					model: execution.model,
					reasoningMode: execution.reasoningMode,
				};
			}
			const prepared = prepareAgentCall(registry, agentCallSelection, {
				allowSubagent: true,
			});
			selectedAgent = prepared.agent;
			selectedModel = prepared.model;
			selectedEffort = prepared.effort;
			selectedReasoningMode = prepared.reasoningMode;
			const beginInput: BeginTurnExecutionInput = {
				agent: prepared.agent,
				childAborts: execution.childAborts,
				model: selectedModel,
				parent: delegation,
				resolvedAgent: prepared.resolvedAgent,
				sessionModel: execution.sessionModel,
				sourceUserMessageId: userMessage.id,
				startedAt: Date.now(),
				turnId,
				...omitUndefined({
					sessionEffort: execution.sessionEffort,
					sessionReasoningMode: execution.sessionReasoningMode,
					effort: selectedEffort,
					reasoningMode: selectedReasoningMode,
				}),
			};
			assertOpen();
			const child = host.begin(beginInput);
			// Recorded the moment it begins, so a failing prompt commit still ends it.
			started = child;
			const childTooling: RuntimeGatedTooling = {
				...tooling,
				delegate: delegationThrough(child),
				gate: createChildGate(tooling, childController),
			};
			child.delegate = createDelegationExecutor({
				...options,
				execution: child,
				tooling: childTooling,
			});
			assertOpen();
			await commitUserMessage();
			return { child, childTooling, prepared };
		};

		try {
			const { child, childTooling, prepared } = await startChild();
			let modelTarget: ModelTarget;
			const targetOptions = {
				allowRetired: true,
				signal: childSignal,
			};
			if (prepared.effort !== undefined) {
				modelTarget = await resolveChatModelTarget(
					prepared.model,
					connections,
					{ ...targetOptions, effort: prepared.effort }
				);
			} else if (prepared.reasoningMode === undefined) {
				modelTarget = await resolveChatModelTarget(
					prepared.model,
					connections,
					targetOptions
				);
			} else {
				modelTarget = await resolveChatModelTarget(
					prepared.model,
					connections,
					{ ...targetOptions, reasoningMode: prepared.reasoningMode }
				);
			}
			const mcpPolicy = await resolveMcpPolicyForAgent(prepared.agent);
			snapshot = await mcp.createSnapshot(prepared.agent, mcpPolicy, false);
			child.mcpSnapshot = snapshot;
			const executeMcpTool = createMcpToolExecutor(mcp.execute);
			const skill = await createSkillContext?.(prepared.agent);
			if (!isUndefined(skill)) {
				child.armedSkill = skill;
			}
			const turn = await buildChildTurn({
				childTooling,
				cwd,
				delegation,
				executeMcpTool,
				modelTarget,
				prepared,
				resolvePermissionForAgent,
				skill,
				snapshot,
				turnId,
				userMessage,
				workspace,
			});
			assertOpen();
			return await runAgentTurnToText({
				onCheckpoint: (record) =>
					commitRecord({
						record,
						sessionId,
					}),
				onTerminal: () => {
					terminalObserved = true;
				},
				onToolCheckpoint: (record) =>
					commitRecord({
						record,
						sessionId,
					}),
				onViewState: (viewState) => {
					if (!isShutDown()) {
						host.publishViewState(child, viewState);
					}
				},
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
				await commitRecord({
					record: buildAssistantFailureSessionRecord({
						agentId: selectedAgent,
						delegation,
						error,
						model: selectedModel,
						sourceUserMessageId: userMessage.id,
						turnId,
						effort: selectedEffort,
						reasoningMode: selectedReasoningMode,
					}),
					sessionId,
				}).catch(() => undefined);
			}
			throw error;
		} finally {
			if (!isUndefined(started)) {
				host.end(started);
			}
		}
	};
};

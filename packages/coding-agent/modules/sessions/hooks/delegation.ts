import { createAgentTurnId } from "@wincode/agent-core";
import {
	type AgentCallSelection,
	prepareAgentCall,
} from "@/modules/agents/agent-call";
import type { ExecutionMode } from "@/shared/execution-mode";
import type { SessionId } from "@/shared/identifiers";
import type {
	DelegationTask,
	DelegationTaskOutcome,
} from "../delegation/types";
import type { SessionCapabilities } from "../host/types";
import { createSessionUserMessage } from "../message";
import type { TurnExecution } from "../turn-execution";
import type {
	DelegationExecutor,
	DelegationRequest,
	DelegationTaskStart,
} from "./runtime-turn";

export type CreateDelegationExecutorOptions = Readonly<{
	capabilities: SessionCapabilities;
	execution: TurnExecution;
	executionMode?: ExecutionMode;
	sessionId: SessionId;
}>;

const selectedAgentCall = (
	execution: TurnExecution,
	agent: AgentCallSelection["agent"]
): AgentCallSelection => {
	if (execution.effort !== undefined) {
		return {
			agent,
			effort: execution.effort,
			model: execution.model,
		};
	}
	if (execution.reasoningMode !== undefined) {
		return {
			agent,
			model: execution.model,
			reasoningMode: execution.reasoningMode,
		};
	}
	return { agent, model: execution.model };
};
const publishTerminalTask = async (
	capabilities: SessionCapabilities,
	taskId: DelegationTaskStart["taskId"],
	outcome: DelegationTaskOutcome
): Promise<void> => {
	const store = capabilities.getStore();
	const report = await store.settleDelegationTask({ outcome, taskId });
	if (report === null) {
		return;
	}
	const task = await store.getDelegationTask(taskId);
	if (task !== null) {
		capabilities.getSessionHostManager().publishDelegationTask(task, report);
	}
};

const prepareDelegationCall = (
	capabilities: SessionCapabilities,
	execution: TurnExecution,
	requestedAgent: AgentCallSelection["agent"]
) => {
	const registry = capabilities.getRegistry();
	const target = registry?.agents.find(
		({ id, isAvailable, role }) =>
			id === requestedAgent &&
			isAvailable &&
			(role === "subagent" || role === "all")
	);
	if (registry === null || target === undefined) {
		throw new Error(`Delegation target '${requestedAgent}' is unavailable.`);
	}
	return prepareAgentCall(registry, selectedAgentCall(execution, target.id), {
		allowSubagent: true,
	});
};
const startDelegatedTask = async (
	capabilities: SessionCapabilities,
	task: DelegationTask,
	executionMode: ExecutionMode | undefined
): Promise<void> => {
	const manager = capabilities.getSessionHostManager();
	try {
		const child = await manager.openHost({
			capabilities,
			...(executionMode === undefined ? {} : { executionMode }),
			sessionId: task.childSessionId,
		});
		const started = child.agentSession.continue();
		if (started.kind === "rejected") {
			throw new Error(started.reason);
		}
	} catch (error) {
		await publishTerminalTask(capabilities, task.id, {
			kind: "failure",
			reason:
				error instanceof Error && error.message.length > 0
					? error.message
					: "Delegated task failed to start.",
		});
		throw error;
	}
};
/** Creates a separate durable child Session and starts its manager-owned Host. */
export const createDelegationExecutor = ({
	capabilities,
	execution,
	executionMode,
	sessionId,
}: CreateDelegationExecutorOptions): DelegationExecutor => {
	const store = capabilities.getStore();
	const manager = capabilities.getSessionHostManager();
	return async (request: DelegationRequest): Promise<DelegationTaskStart> => {
		const prepared = prepareDelegationCall(
			capabilities,
			execution,
			request.agent
		);
		const message = createSessionUserMessage(request.prompt, {
			agent: prepared.agent,
			model: prepared.model,
			...(prepared.effort === undefined ? {} : { effort: prepared.effort }),
			...(prepared.reasoningMode === undefined
				? {}
				: { reasoningMode: prepared.reasoningMode }),
		});
		const task = await store.createDelegatedTask({
			agent: prepared.agent,
			message,
			model: prepared.model,
			parentSessionId: sessionId,
			parentToolCallId: request.parentToolCallId,
			parentTurnId: request.parentTurnId,
			turnId: createAgentTurnId(),
			...(prepared.effort === undefined ? {} : { effort: prepared.effort }),
			...(prepared.reasoningMode === undefined
				? {}
				: { reasoningMode: prepared.reasoningMode }),
		});
		manager.registerDelegatedTask(task);
		await startDelegatedTask(capabilities, task, executionMode);
		return {
			childSessionId: task.childSessionId,
			status: "active",
			taskId: task.id,
		};
	};
};

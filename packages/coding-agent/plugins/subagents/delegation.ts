import {
	type AgentTurnTerminalEvent,
	createAgentTurnId,
} from "@wincode/agent-core";
import type {
	DelegationExecutor,
	DelegationRequest,
	DelegationTaskStart,
	SubmitResultExecutor,
} from "@wincode/subagents";
import { getErrorMessage } from "@wincode/utils";
import {
	type AgentCallSelection,
	prepareAgentCall,
} from "@/modules/agents/agent-call";
import type {
	DelegationTask,
	DelegationTaskOutcome,
} from "@/modules/sessions/delegation/types";
import type { SessionCapabilities } from "@/modules/sessions/host/types";
import { createSessionUserMessage } from "@/modules/sessions/message";
import type { TurnExecution } from "@/modules/sessions/turn-execution";
import type { ExecutionMode } from "@/shared/execution-mode";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";

export type CreateDelegationExecutorOptions = Readonly<{
	capabilities: SessionCapabilities;
	execution: TurnExecution;
	executionMode?: ExecutionMode;
	sessionId: SessionId;
}>;

const errorMessageOrFallback = (error: unknown, fallback: string): string => {
	const message = getErrorMessage(error);
	return message.length > 0 ? message : fallback;
};

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
export const publishDelegationTaskOutcome = async (
	capabilities: SessionCapabilities,
	taskId: DelegationTaskId,
	outcome: DelegationTaskOutcome
): Promise<boolean> => {
	const store = capabilities.getStore();
	const report = await store.settleDelegationTask({ outcome, taskId });
	if (report === null) {
		return false;
	}
	const task = await store.getDelegationTask(taskId);
	if (task !== null) {
		capabilities.getSessionHostManager().delegation.publishTask(task, report);
	}
	return true;
};

export const createSubmitResultExecutor =
	(
		capabilities: SessionCapabilities,
		taskId: DelegationTaskId
	): SubmitResultExecutor =>
	(report) =>
		publishDelegationTaskOutcome(capabilities, taskId, {
			kind: "result",
			report,
		});

export const settleDelegatedTaskAfterTurn = async (
	capabilities: SessionCapabilities,
	task: DelegationTask,
	event: AgentTurnTerminalEvent
): Promise<void> => {
	const store = capabilities.getStore();
	if (event.type === "agent-turn-completed") {
		await store.markDelegationTaskAwaitingReport(task.id);
		const current = await store.getDelegationTask(task.id);
		if (current?.status === "awaiting_report") {
			capabilities.getSessionHostManager().delegation.publishTask(current);
		}
		return;
	}
	let outcome: DelegationTaskOutcome;
	if (event.type === "agent-turn-cancelled") {
		outcome = { kind: "cancelled", reason: event.failure.message };
	} else if (event.type === "agent-turn-interrupted") {
		outcome = { kind: "interrupted", reason: event.failure.message };
	} else {
		outcome = { kind: "failure", reason: event.failure.message };
	}
	await publishDelegationTaskOutcome(capabilities, task.id, outcome);
};

export const failDelegatedTask = async (
	capabilities: SessionCapabilities,
	taskId: DelegationTaskId,
	error: unknown
): Promise<void> => {
	const reason = errorMessageOrFallback(error, "Delegated task failed.");
	await publishDelegationTaskOutcome(capabilities, taskId, {
		kind: "failure",
		reason,
	});
};

export const hasDelegationTargets = (
	capabilities: SessionCapabilities
): boolean =>
	capabilities
		.getRegistry()
		?.agents.some(
			({ isAvailable, role }) =>
				isAvailable && (role === "subagent" || role === "all")
		) === true;

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
		await publishDelegationTaskOutcome(capabilities, task.id, {
			kind: "failure",
			reason: errorMessageOrFallback(error, "Delegated task failed to start."),
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
}: CreateDelegationExecutorOptions): DelegationExecutor<
	SessionId,
	DelegationTaskId
> => {
	const store = capabilities.getStore();
	const manager = capabilities.getSessionHostManager();
	return async (
		request: DelegationRequest
	): Promise<DelegationTaskStart<SessionId, DelegationTaskId>> => {
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
		manager.delegation.registerTask(task);
		await startDelegatedTask(capabilities, task, executionMode);
		return {
			childSessionId: task.childSessionId,
			status: "active",
			taskId: task.id,
		};
	};
};

import type { AgentTurnTerminalEvent } from "@wincode/agent-core";
import type {
	DelegationExecutor,
	DelegationRequest,
	DelegationTaskStart,
	SubmitResultExecutor,
} from "@wincode/subagents";
import { getErrorMessage } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import {
	type AgentCallSelection,
	prepareAgentCall,
} from "@/modules/agents/agent-call";
import type {
	DelegationTask,
	DelegationTaskOutcome,
} from "@/modules/sessions/delegation/types";
import type { SessionCapabilities } from "@/modules/sessions/host/types";

import type {
	SessionSdk,
	SessionSdkHandle,
} from "@/modules/sessions/sdk-contract";
import type { TurnExecution } from "@/modules/sessions/turn-execution";
import {
	type DelegationTaskId,
	type SessionId,
	toSessionId,
} from "@/shared/identifiers";
import type { SubagentsTaskStore } from "./store";

export type CreateDelegationExecutorOptions = Readonly<{
	capabilities: SessionCapabilities;
	taskStore: SubagentsTaskStore;
	execution: TurnExecution;
	sessionId: SessionId;
}>;

const sdkChildren = new Map<
	DelegationTaskId,
	Readonly<{ sdk: SessionSdk; handle: SessionSdkHandle }>
>();

const releaseSdkChild = async (taskId: DelegationTaskId): Promise<void> => {
	const child = sdkChildren.get(taskId);
	if (child === undefined) {
		return;
	}
	sdkChildren.delete(taskId);
	await Promise.allSettled([child.handle.dispose(), child.sdk.dispose()]);
};

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
	taskStore: SubagentsTaskStore,
	taskId: DelegationTaskId,
	outcome: DelegationTaskOutcome
): Promise<boolean> => {
	const store = capabilities.getStore();
	const report = taskStore.settleTask({ outcome, taskId });
	const legacyTask = await store.getDelegationTask(taskId);
	const legacyReport =
		legacyTask === null
			? null
			: await store.settleDelegationTask({ outcome, taskId });
	if (report === null && legacyReport === null) {
		return false;
	}
	const task = taskStore.getTask(taskId) ?? legacyTask;
	if (task !== null) {
		capabilities
			.getSessionHostManager()
			.delegation.publishTask(task, legacyReport ?? undefined);
	}
	return true;
};

export const createSubmitResultExecutor =
	(
		capabilities: SessionCapabilities,
		taskStore: SubagentsTaskStore,
		taskId: DelegationTaskId
	): SubmitResultExecutor =>
	(report) =>
		publishDelegationTaskOutcome(capabilities, taskStore, taskId, {
			kind: "result",
			report,
		});

export const settleDelegatedTaskAfterTurn = async (
	capabilities: SessionCapabilities,
	taskStore: SubagentsTaskStore,
	task: DelegationTask,
	event: AgentTurnTerminalEvent
): Promise<void> => {
	const store = capabilities.getStore();
	if (event.type === "agent-turn-completed") {
		taskStore.markAwaitingReport(task.id);
		await store.markDelegationTaskAwaitingReport(task.id);
		const current = taskStore.getTask(task.id);
		if (current?.status === "awaiting_report") {
			capabilities.getSessionHostManager().delegation.publishTask(current);
		}
		await releaseSdkChild(task.id);
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
	await publishDelegationTaskOutcome(capabilities, taskStore, task.id, outcome);
	await releaseSdkChild(task.id);
};

export const failDelegatedTask = async (
	capabilities: SessionCapabilities,
	taskStore: SubagentsTaskStore,
	taskId: DelegationTaskId,
	error: unknown
): Promise<void> => {
	const reason = errorMessageOrFallback(error, "Delegated task failed.");
	await publishDelegationTaskOutcome(capabilities, taskStore, taskId, {
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
/** Creates a child through the public SDK with an explicit Plugin set. */
export const createDelegationExecutor = ({
	capabilities,
	taskStore,
	execution,
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
		const parentSdk = capabilities.getSessionSdk?.();
		if (parentSdk === undefined) {
			throw new Error("The Subagents Plugin requires the public Session SDK.");
		}
		const childSdk = await parentSdk.createChildSdk({
			enabledPlugins: ["subagents"],
		});
		const childSessionId = toSessionId(randomUUIDv7());
		let task: DelegationTask | null = null;
		let childHandle: SessionSdkHandle | undefined;
		try {
			await childSdk.createEmptySession({
				sessionId: childSessionId,
				agent: prepared.agent,
				model: prepared.model,
				...(prepared.effort === undefined ? {} : { effort: prepared.effort }),
				...(prepared.reasoningMode === undefined
					? {}
					: { reasoningMode: prepared.reasoningMode }),
			});
			task = taskStore.createTask({
				agentId: prepared.agent,
				childSessionId,
				parentSessionId: sessionId,
				parentToolCallId: request.parentToolCallId,
				parentTurnId: request.parentTurnId,
			});
			manager.delegation.registerTask(task);
			await store.linkDelegatedTask({
				id: task.id,
				agent: prepared.agent,
				childSessionId,
				parentSessionId: sessionId,
				parentToolCallId: request.parentToolCallId,
				parentTurnId: request.parentTurnId,
			});
			childHandle = await childSdk.openSession(childSessionId, { view: true });
			sdkChildren.set(task.id, { handle: childHandle, sdk: childSdk });
			const admission = await childHandle.prompt({
				text: request.prompt,
				agent: prepared.agent,
				model: prepared.model,
				...(prepared.effort === undefined ? {} : { effort: prepared.effort }),
				...(prepared.reasoningMode === undefined
					? {}
					: { reasoningMode: prepared.reasoningMode }),
			});
			if (admission.rejected) {
				throw new Error(admission.reason);
			}
			return {
				childSessionId: task.childSessionId,
				status: "active",
				taskId: task.id,
			};
		} catch (error) {
			if (task === null) {
				await childSdk.dispose();
			} else {
				await failDelegatedTask(capabilities, taskStore, task.id, error);
				await releaseSdkChild(task.id);
			}
			throw error;
		}
	};
};

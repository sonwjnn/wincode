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
import type {
	SessionSdk,
	SessionSdkHandle,
} from "@/modules/sessions/sdk-contract";
import type { TurnExecution } from "@/modules/sessions/turn-execution";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";

export type CreateDelegationExecutorOptions = Readonly<{
	capabilities: SessionCapabilities;
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
	await publishDelegationTaskOutcome(capabilities, task.id, outcome);
	await releaseSdkChild(task.id);
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
	task: DelegationTask
): Promise<void> => {
	const sdk = capabilities.getSessionSdk?.();
	if (sdk === undefined) {
		throw new Error("The Subagents Plugin requires the public Session SDK.");
	}
	const childSdk = await sdk.createChildSdk({
		enabledPlugins: ["subagents"],
	});
	try {
		const handle = await childSdk.openSession(task.childSessionId, {
			view: true,
		});
		sdkChildren.set(task.id, { handle, sdk: childSdk });
		const started = handle.continue();
		if (started.kind === "rejected") {
			throw new Error(started.reason);
		}
	} catch (error) {
		await releaseSdkChild(task.id);
		await childSdk.dispose();
		throw error;
	}
};
/** Creates a separate durable child Session and starts its manager-owned Host. */
export const createDelegationExecutor = ({
	capabilities,
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
		await startDelegatedTask(capabilities, task);
		return {
			childSessionId: task.childSessionId,
			status: "active",
			taskId: task.id,
		};
	};
};

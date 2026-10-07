import type { AgentId, AgentTurnId } from "@wincode/agent-core";
import type {
	DelegationExecutor,
	DelegationRequest,
	SubmitResultExecutor,
} from "@wincode/subagents";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkChildFactory,
} from "@/modules/sessions/sdk-contract";
import type { SessionId } from "@/shared/identifiers";
import type { SubagentsTaskCoordinator } from "./task-runtime";
import type { DelegationTask } from "./task-types";

export type SubagentsTurnContext = Readonly<{
	agentId: AgentId;
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	sessionId: SessionId;
	sessionSdk: SessionSdkChildFactory;
	turnId: AgentTurnId;
}>;

export type CreateDelegationExecutorOptions = Readonly<{
	coordinator: SubagentsTaskCoordinator;
	sessionSdk: SessionSdkChildFactory;
	turn: SubagentsTurnContext;
}>;

export const hasDelegationTargets = async (
	sessionSdk: SessionSdkChildFactory
): Promise<boolean> =>
	(await sessionSdk.getAgentCatalog()).some(
		({ isAvailable, role }) =>
			isAvailable && (role === "subagent" || role === "all")
	);

export const createDelegationExecutor = ({
	coordinator,
	sessionSdk,
	turn,
}: CreateDelegationExecutorOptions): DelegationExecutor => {
	const sessionId = turn.sessionId;
	const turnId = turn.turnId;
	return async (
		request: DelegationRequest,
		signal
	): Promise<{
		childSessionId: string;
		status: "active";
		taskId: string;
	}> => {
		const target = (await sessionSdk.getAgentCatalog()).find(
			({ id, isAvailable, role }) =>
				id === request.agent &&
				isAvailable &&
				(role === "subagent" || role === "all")
		);
		if (target === undefined) {
			throw new Error(`Delegation target '${request.agent}' is unavailable.`);
		}
		if (signal?.aborted) {
			throw new Error("Delegated task was cancelled before it started.");
		}
		return coordinator.startTask({
			agentId: target.id,
			...(turn.capabilityCeiling === undefined
				? {}
				: { capabilityCeiling: turn.capabilityCeiling }),
			parentSessionId: sessionId,
			parentToolCallId: request.parentToolCallId,
			parentTurnId: turnId,
			prompt: request.prompt,
			sessionSdk,
		});
	};
};

export const createSubmitResultExecutor =
	(
		coordinator: SubagentsTaskCoordinator,
		task: DelegationTask
	): SubmitResultExecutor =>
	(result) =>
		coordinator.settleTask(task.id, {
			kind: "result",
			report: result,
		});

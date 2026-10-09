import type { AgentId, AgentTurnId } from "@wincode/agent-core";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkOperations,
} from "@wincode/coding-agent";
import type {
	DelegationExecutor,
	DelegationRequest,
	SubmitResultExecutor,
} from "../tools";
import type { SubagentsTaskCoordinator } from "./task-runtime";
import type { DelegationTask, SessionId } from "./task-types";

export type SubagentsTurnContext = Readonly<{
	agentId: AgentId;
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	pluginPath: string;
	sessionId: SessionId;
	sessionSdk: SessionSdkOperations;
	turnId: AgentTurnId;
}>;

export type CreateDelegationExecutorOptions = Readonly<{
	coordinator: SubagentsTaskCoordinator;
	sessionSdk: SessionSdkOperations;
	turn: SubagentsTurnContext;
}>;

export const hasDelegationTargets = async (
	sessionSdk: SessionSdkOperations,
	capabilityCeiling?: SessionSdkCapabilityCeiling
): Promise<boolean> =>
	(
		await sessionSdk.getAgentCatalog(
			capabilityCeiling === undefined ? undefined : { capabilityCeiling }
		)
	).some(
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
		const target = (
			await sessionSdk.getAgentCatalog(
				turn.capabilityCeiling === undefined
					? undefined
					: { capabilityCeiling: turn.capabilityCeiling }
			)
		).find(({ id }) => id === request.agent);
		if (
			target === undefined ||
			(target.role !== "subagent" && target.role !== "all")
		) {
			throw new Error(`Delegation target '${request.agent}' is unavailable.`);
		}
		if (!target.isAvailable) {
			throw new Error(
				`Delegation target '${request.agent}' is unavailable: ${target.unavailableReason ?? "required capabilities are missing"}.`
			);
		}
		if (signal?.aborted) {
			throw new Error("Delegated task was cancelled before it started.");
		}
		return coordinator.startTask({
			agentId: target.id,
			...(target.model === undefined ? {} : { model: target.model }),
			...(target.thinkingLevel === undefined
				? {}
				: { thinkingLevel: target.thinkingLevel }),
			...(turn.capabilityCeiling === undefined
				? {}
				: { capabilityCeiling: turn.capabilityCeiling }),
			parentSessionId: sessionId,
			parentToolCallId: request.parentToolCallId,
			parentTurnId: turnId,
			pluginPath: turn.pluginPath,
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

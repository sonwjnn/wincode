import { createSubagentTools } from "@wincode/subagents";
import type { SubagentsToolProviderContext } from "@/modules/application/plugins/turn-context";
import { withBundledToolGate } from "@/modules/plugins/bundled-tools";
import { getPluginHostContext } from "@/modules/plugins/host-context";
import type { PluginFactory } from "@/modules/plugins/public";
import type {
	SessionCapabilities,
	SessionDelegationAdapter,
	SessionDelegationRuntimeFactory,
} from "@/modules/sessions/host/types";
import { evaluateGateWithAbort } from "@/modules/tool-gate/evaluate-with-abort";
import {
	createDelegationExecutor,
	createSubmitResultExecutor,
	failDelegatedTask,
	hasDelegationTargets,
	settleDelegatedTaskAfterTurn,
} from "./delegation";
import { createSubagentTaskRuntime } from "./task-runtime";

/** Registers delegation tools through the shared public Plugin API. */
export const subagentsPluginFactory: PluginFactory = (api) => {
	const plugin = api.definePlugin({ id: "subagents" });
	plugin.onBeforeAgentTurn((context, registration) => {
		const turn = getPluginHostContext<SubagentsToolProviderContext>(context);
		if (turn === undefined) {
			return;
		}
		for (const tool of createSubagentTools(turn)) {
			registration.registerTool(
				withBundledToolGate(
					{
						description: tool.definition.description,
						...(tool.definition.exclusiveInBatch === true
							? { exclusiveInBatch: true }
							: {}),
						handler: async (input, toolContext) => {
							const action =
								tool.definition.name === "delegate"
									? "delegate"
									: "submit_result";
							const permission =
								action === "delegate"
									? await turn.resolveDelegationPermission?.(turn.agentId)
									: { decision: "allow" as const, safety: false };
							const outcome = await evaluateGateWithAbort(
								() =>
									turn.gate.gate({
										action,
										agentId: turn.agentId,
										decision: permission?.decision ?? "ask",
										description: tool.definition.description,
										family: "delegation",
										input,
										safety: permission?.safety ?? true,
										toolCallId: toolContext.toolCallId,
										toolName: tool.definition.name,
									}),
								toolContext.signal
							);
							if (outcome.kind !== "allow") {
								return {
									errorText: outcome.errorText,
									type: "failure",
								};
							}
							return tool.execute(
								{ input, toolCallId: toolContext.toolCallId },
								{ signal: toolContext.signal }
							);
						},
						inputSchema: tool.definition.inputSchema,
						name: tool.definition.name,
					},
					"delegation",
					tool.definition.name
				)
			);
		}
	});
};

/** Owns the private host integration used to execute Subagents Sessions. */
export const createSubagentsSessionAdapter = (
	capabilities: SessionCapabilities
): SessionDelegationAdapter => ({
	createExecutor: ({ execution, sessionId }) =>
		createDelegationExecutor({ capabilities, execution, sessionId }),
	createSubmitResultExecutor: (taskId) =>
		createSubmitResultExecutor(capabilities, taskId),
	failTask: (taskId, error) => failDelegatedTask(capabilities, taskId, error),
	hasTargets: () => hasDelegationTargets(capabilities),
	settleAfterTurn: (task, event) =>
		settleDelegatedTaskAfterTurn(capabilities, task, event),
});

export const createSubagentsSessionRuntime: SessionDelegationRuntimeFactory =
	createSubagentTaskRuntime;

export * from "./delegation";
export * from "./task-runtime";

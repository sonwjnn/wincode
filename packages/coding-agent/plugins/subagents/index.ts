import type { ResolvedTool, ToolCallOutput } from "@wincode/agent-core";
import { createSubagentTools } from "@wincode/subagents";
import { withBundledToolName } from "@/modules/plugins/bundled-tools";
import type {
	PluginBeforeAgentTurnContext,
	PluginFactory,
	PluginToolContext,
	PluginToolRegistrationAPI,
} from "@/modules/plugins/public";
import { toSessionId } from "@/shared/identifiers";
import {
	createDelegationExecutor,
	createSubmitResultExecutor,
	hasDelegationTargets,
	type SubagentsTurnContext,
} from "./delegation";
import {
	acquireSharedSubagentsTaskStore,
	resolveSubagentsDatabasePath,
	type SubagentsTaskStore,
} from "./store";
import type { SubagentsTaskCoordinator } from "./task-runtime";
import { getSubagentsTaskCoordinator } from "./task-runtime";

/** Creates the Subagents Plugin with its own durable task/report store. */
export const createSubagentsPluginFactory =
	(
		options: Readonly<{
			databasePath?: string;
			taskStore?: SubagentsTaskStore | Promise<SubagentsTaskStore>;
		}> = {}
	): PluginFactory =>
	async (api, loadContext) => {
		const storeLease =
			options.taskStore === undefined
				? await acquireSharedSubagentsTaskStore(
						options.databasePath ??
							resolveSubagentsDatabasePath(loadContext.workspace)
					)
				: undefined;
		let durableTaskStore: SubagentsTaskStore;
		if (storeLease !== undefined) {
			durableTaskStore = storeLease.store;
		} else if (options.taskStore === undefined) {
			throw new Error("Subagents task store acquisition failed.");
		} else {
			durableTaskStore = await options.taskStore;
		}
		const plugin = api.definePlugin({ id: "subagents" });
		const coordinator = getSubagentsTaskCoordinator(durableTaskStore);
		if (storeLease !== undefined) {
			plugin.onShutdown(storeLease.release);
		}
		plugin.onSessionStart((context) => coordinator.onSessionStart(context));
		plugin.onSessionShutdown((context) =>
			coordinator.onSessionShutdown(context)
		);
		plugin.onBeforeAgentTurn(async (context, registration) => {
			const turn = getSubagentsTurn(context);
			if (turn === undefined) {
				return;
			}
			const tools = await createSubagentsToolsForTurn(
				turn,
				coordinator,
				durableTaskStore
			);
			registerSubagentsTools(registration, tools, turn, coordinator);
		});
	};

const getSubagentsTurn = (
	context: PluginBeforeAgentTurnContext
): SubagentsTurnContext | undefined => {
	if (context.sessionSdk === undefined || context.turnId === undefined) {
		return;
	}
	return {
		agentId: context.agentId,
		...(context.capabilityCeiling === undefined
			? {}
			: { capabilityCeiling: context.capabilityCeiling }),
		sessionId: toSessionId(context.sessionId),
		sessionSdk: context.sessionSdk,
		turnId: context.turnId,
	};
};

const createSubagentsToolsForTurn = async (
	turn: SubagentsTurnContext,
	coordinator: SubagentsTaskCoordinator,
	taskStore: SubagentsTaskStore
): Promise<readonly ResolvedTool[]> => {
	const childTask = taskStore.getTaskForChild(turn.sessionId);
	const submitTask =
		childTask !== null &&
		(childTask.status === "active" || childTask.status === "awaiting_report")
			? childTask
			: null;
	const canDelegate = await hasDelegationTargets(turn.sessionSdk);
	return createSubagentTools({
		...(canDelegate
			? {
					delegate: createDelegationExecutor({
						coordinator,
						sessionSdk: turn.sessionSdk,
						turn,
					}),
					parentTurnId: turn.turnId,
				}
			: {}),
		...(submitTask === null
			? {}
			: {
					delegationTaskId: submitTask.id,
					submitResult: createSubmitResultExecutor(coordinator, submitTask),
				}),
	});
};

const registerSubagentsTools = (
	registration: PluginToolRegistrationAPI,
	tools: readonly ResolvedTool[],
	turn: SubagentsTurnContext,
	coordinator: SubagentsTaskCoordinator
): void => {
	for (const tool of tools) {
		registration.registerTool(
			withBundledToolName(
				{
					description: tool.definition.description,
					...(tool.definition.exclusiveInBatch === true
						? { exclusiveInBatch: true }
						: {}),
					handler: createSubagentsToolHandler(tool, turn, coordinator),
					inputSchema: tool.definition.inputSchema,
					name: tool.definition.name,
					permissionAction:
						tool.definition.name === "delegate" ? "delegate" : "submit_result",
					permissionResource: "*",
				},
				tool.definition.name
			)
		);
	}
};

const createSubagentsToolHandler =
	(
		tool: ResolvedTool,
		turn: SubagentsTurnContext,
		coordinator: SubagentsTaskCoordinator
	) =>
	async (
		input: unknown,
		toolContext: PluginToolContext
	): Promise<ToolCallOutput> => {
		const action =
			tool.definition.name === "delegate" ? "delegate" : "submit_result";
		const result = await tool.execute(
			{ input, toolCallId: toolContext.toolCallId },
			{ signal: toolContext.signal }
		);
		if (action === "delegate" && result.type === "success") {
			toolContext.registerBackgroundWork(
				coordinator.waitForTasks(turn.sessionId).then((tasks) => {
					const unfinishedTask = tasks.find(
						(task) => task.status !== "succeeded"
					);
					if (unfinishedTask !== undefined) {
						throw new Error(
							unfinishedTask.status === "awaiting_report"
								? `Delegation Task ${unfinishedTask.id} is awaiting_report. One-Shot mode will not continue the parent Session automatically; submit its report explicitly.`
								: `Delegation Task ${unfinishedTask.id} ended with status '${unfinishedTask.status}'.`
						);
					}
				})
			);
		}
		return result;
	};

export * from "./delegation";
export * from "./task-runtime";
export * from "./task-types";

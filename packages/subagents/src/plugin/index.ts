import type { ResolvedTool, ToolCallOutput } from "@wincode/agent-core";
import type {
	PluginBeforeAgentTurnContext,
	PluginFactory,
	PluginToolContext,
	PluginToolRegistrationAPI,
	SessionSdkAgent,
	SessionSdkOperations,
} from "@wincode/coding-agent";
import { logger } from "@wincode/utils";
import { discoverSubagentAgents } from "../agents";
import { createSubagentTools } from "../tools";
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
import { toSessionId } from "./task-types";

/** Creates the Subagents Plugin with its own durable task/report store. */
export const createSubagentsPluginFactory =
	(
		options: Readonly<{
			databasePath?: string;
			taskStore?: SubagentsTaskStore | Promise<SubagentsTaskStore>;
		}> = {}
	): PluginFactory =>
	async (api, loadContext) => {
		let durableTaskStore =
			options.taskStore === undefined ? undefined : await options.taskStore;
		let releaseTaskStore: (() => void) | undefined;
		let coordinator: SubagentsTaskCoordinator | undefined;
		const plugin = api.definePlugin({ id: "subagents" });
		plugin.onStart(async () => {
			if (durableTaskStore === undefined) {
				const storeLease = await acquireSharedSubagentsTaskStore(
					options.databasePath ??
						resolveSubagentsDatabasePath(
							loadContext.workspace,
							loadContext.userDataDir
						)
				);
				durableTaskStore = storeLease.store;
				releaseTaskStore = storeLease.release;
			}
			if (durableTaskStore === undefined) {
				throw new Error("Subagents task store acquisition failed.");
			}
			coordinator = getSubagentsTaskCoordinator(
				durableTaskStore,
				loadContext.sourcePath
			);
		});
		plugin.onShutdown(async () => {
			coordinator = undefined;
			if (releaseTaskStore !== undefined) {
				const release = releaseTaskStore;
				releaseTaskStore = undefined;
				durableTaskStore = undefined;
				await release();
			}
		});
		const discovery = await discoverSubagentAgents({
			trustedProjectRoots: loadContext.trustedProjectRoots,
			userDataDir: loadContext.userDataDir,
		});
		for (const diagnostic of discovery.diagnostics) {
			void logger.warn("Subagent discovery diagnostic", {
				message: diagnostic,
				operation: "subagents.discovery",
				sourcePath: loadContext.sourcePath,
			});
		}
		for (const agent of discovery.agents) {
			plugin.registerAgent(agent);
		}
		const getActiveCoordinator = (): SubagentsTaskCoordinator => {
			if (coordinator === undefined) {
				throw new Error("Subagents Plugin process has not started.");
			}
			return coordinator;
		};
		const getActiveTaskStore = (): SubagentsTaskStore => {
			if (durableTaskStore === undefined) {
				throw new Error("Subagents task store is unavailable.");
			}
			return durableTaskStore;
		};
		const sessionSdks = new Map<string, SessionSdkOperations>();
		plugin.registerCommand({
			description: "List subagents and explain unavailable requirements.",
			name: "subagents",
			handler: async ({ sessionId }) => {
				const sessionSdk =
					sessionId === undefined ? undefined : sessionSdks.get(sessionId);
				if (sessionSdk === undefined) {
					return "Subagent catalog is unavailable for this Session.";
				}
				return formatSubagents(await sessionSdk.getAgentCatalog());
			},
		});
		plugin.onSessionStart((context) => {
			if (context.sessionSdk !== undefined) {
				sessionSdks.set(context.sessionId, context.sessionSdk);
			}
			getActiveCoordinator().onSessionStart(context);
		});
		plugin.onSessionShutdown((context) => {
			sessionSdks.delete(context.sessionId);
			return getActiveCoordinator().onSessionShutdown(context);
		});
		plugin.onBeforeAgentTurn(async (context, registration) => {
			const turn = getSubagentsTurn(context, loadContext.sourcePath);
			if (turn === undefined) {
				return;
			}
			const tools = await createSubagentsToolsForTurn(
				turn,
				getActiveCoordinator(),
				getActiveTaskStore()
			);
			registerSubagentsTools(registration, tools, turn, getActiveCoordinator());
		});
	};

export const formatSubagents = (agents: readonly SessionSdkAgent[]): string => {
	const subagents = agents
		.filter(({ role }) => role === "subagent" || role === "all")
		.toSorted((left, right) => left.id.localeCompare(right.id));
	if (subagents.length === 0) {
		return "No subagents are registered.";
	}
	return [
		"Subagents:",
		...subagents.map((agent) => {
			const status = agent.isAvailable
				? "available"
				: `unavailable: ${agent.unavailableReason ?? "required capabilities are missing"}`;
			const source = agent.source === undefined ? "" : ` [${agent.source}]`;
			return `- ${agent.id}${source} — ${status}\n  ${agent.description ?? "No description available."}`;
		}),
	].join("\n");
};

const getSubagentsTurn = (
	context: PluginBeforeAgentTurnContext,
	pluginPath: string
): SubagentsTurnContext | undefined => {
	if (context.sessionSdk === undefined || context.turnId === undefined) {
		return;
	}
	return {
		agentId: context.agentId,
		...(context.capabilityCeiling === undefined
			? {}
			: { capabilityCeiling: context.capabilityCeiling }),
		pluginPath,
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
	const canDelegate = await hasDelegationTargets(
		turn.sessionSdk,
		turn.capabilityCeiling
	);
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
		registration.registerTool({
			description: tool.definition.description,
			...(tool.definition.exclusiveInBatch === true
				? { exclusiveInBatch: true }
				: {}),
			handler: createSubagentsToolHandler(tool, turn, coordinator),
			inputSchema: tool.definition.inputSchema,
			modelName: tool.definition.name,
			name: tool.definition.name,
		});
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
export * from "./store";
export * from "./task-runtime";
export * from "./task-types";

export const subagentsPluginFactory = createSubagentsPluginFactory();
export default subagentsPluginFactory;

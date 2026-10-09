import { expect, test } from "bun:test";
import { parseCatalogModelSelection } from "@wincode/ai/models";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkOperations,
} from "@wincode/coding-agent";
import {
	createDelegationExecutor,
	hasDelegationTargets,
	type SubagentsTurnContext,
} from "../src/plugin/delegation";
import type {
	StartSubagentsTaskInput,
	SubagentsTaskCoordinator,
} from "../src/plugin/task-runtime";
import { toDelegationTaskId } from "../src/plugin/task-types";
import type { DelegationRequest } from "../src/tools";
import { agentId, agentTurnId, sessionId, toolCallId } from "./identifiers";

const unavailableAgentCatalog = {
	getAgentCatalog: async () => [
		{
			description: "Research with web tools.",
			id: agentId("researcher"),
			isAvailable: false,
			role: "subagent",
			unavailableReason: "Missing required child tools: web_search",
		},
	],
} as unknown as SessionSdkOperations;

const taskCoordinator = {
	getTaskForChild: () => null,
	onSessionShutdown: async () => undefined,
	onSessionStart: () => undefined,
	settleTask: async () => false,
	startTask: async () => {
		throw new Error("Unavailable agents must not start child tasks.");
	},
	waitForTasks: async () => [],
} satisfies SubagentsTaskCoordinator;

const request: DelegationRequest = {
	agent: agentId("researcher"),
	parentToolCallId: toolCallId("parent-call"),
	parentTurnId: agentTurnId("parent-turn"),
	prompt: "Research the question.",
};

const turn: SubagentsTurnContext = {
	agentId: agentId("build"),
	pluginPath: "/plugins/subagents.ts",
	sessionId: sessionId("parent-session"),
	sessionSdk: unavailableAgentCatalog,
	turnId: agentTurnId("parent-turn"),
};

test("delegation rejects an unavailable profile with its missing-tool reason before starting a child", async () => {
	const execute = createDelegationExecutor({
		coordinator: taskCoordinator,
		sessionSdk: unavailableAgentCatalog,
		turn,
	});

	await expect(execute(request, undefined)).rejects.toThrow(
		"Delegation target 'researcher' is unavailable: Missing required child tools: web_search."
	);
});

test("delegation applies the current Agent ceiling before starting a child task", async () => {
	const capabilityCeiling: SessionSdkCapabilityCeiling = { tools: ["read"] };
	let requestedCeiling: SessionSdkCapabilityCeiling | undefined;
	const sessionSdk = {
		getAgentCatalog: async (
			options?: Readonly<{
				capabilityCeiling?: SessionSdkCapabilityCeiling;
			}>
		) => {
			requestedCeiling = options?.capabilityCeiling;
			const missingShell =
				options?.capabilityCeiling?.tools.includes("shell") !== true;
			return [
				{
					description: "Runs shell-based inspection.",
					id: agentId("researcher"),
					isAvailable: !missingShell,
					requiredTools: ["shell"],
					role: "subagent",
					...(missingShell
						? { unavailableReason: "Missing required child tools: shell" }
						: {}),
				},
			];
		},
	} as unknown as SessionSdkOperations;
	let taskStarted = false;
	const coordinator: SubagentsTaskCoordinator = {
		...taskCoordinator,
		startTask: async () => {
			taskStarted = true;
			return {
				childSessionId: sessionId("child-session"),
				status: "active",
				taskId: toDelegationTaskId("task-1"),
			};
		},
	};
	const turnWithCeiling: SubagentsTurnContext = {
		...turn,
		capabilityCeiling,
		sessionSdk,
	};
	const execute = createDelegationExecutor({
		coordinator,
		sessionSdk,
		turn: turnWithCeiling,
	});

	expect(await hasDelegationTargets(sessionSdk, capabilityCeiling)).toBe(false);
	await expect(execute(request, undefined)).rejects.toThrow(
		"Delegation target 'researcher' is unavailable: Missing required child tools: shell."
	);
	expect(requestedCeiling).toEqual(capabilityCeiling);
	expect(taskStarted).toBe(false);
});

test("delegation forwards a Markdown profile's model and thinking level to the child task", async () => {
	const model = parseCatalogModelSelection("openai/gpt-5.6-luna");
	if (model === null) {
		throw new Error("Expected the test model to exist in the catalog.");
	}
	const sessionSdk = {
		getAgentCatalog: async () => [
			{
				description: "Implement focused code changes.",
				thinkingLevel: "high" as const,
				id: agentId("worker"),
				isAvailable: true,
				model,
				role: "subagent",
			},
		],
	} as unknown as SessionSdkOperations;
	let startedInput: StartSubagentsTaskInput | undefined;
	const coordinator: SubagentsTaskCoordinator = {
		...taskCoordinator,
		startTask: async (input) => {
			startedInput = input;
			return {
				childSessionId: sessionId("child-session"),
				status: "active",
				taskId: toDelegationTaskId("task-1"),
			};
		},
	};
	const execute = createDelegationExecutor({
		coordinator,
		sessionSdk,
		turn: { ...turn, sessionSdk },
	});

	await execute({ ...request, agent: agentId("worker") }, undefined);
	expect(startedInput).toMatchObject({
		thinkingLevel: "high",
		model,
	});
});

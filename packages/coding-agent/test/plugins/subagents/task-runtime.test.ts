import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { toSubmissionId } from "@wincode/agent-core";
import { loadPlugins } from "@/modules/plugins/loader";
import type { PluginBeforeAgentTurnContext } from "@/modules/plugins/public";
import type {
	SessionSdk,
	SessionSdkChildFactory,
	SessionSdkDelivery,
	SessionSdkHandle,
} from "@/modules/sessions/sdk-contract";
import { createSubagentsPluginFactory } from "@/plugins/subagents";
import {
	createSubagentsTaskStore,
	type SubagentsTaskStore,
} from "@/plugins/subagents/store";
import { getSubagentsTaskCoordinator } from "@/plugins/subagents/task-runtime";
import { toDelegationTaskId } from "@/plugins/subagents/task-types";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";
import {
	agentId,
	agentTurnId,
	sessionId,
	sessionMessageId,
	toolCallId,
} from "../../support/identifiers";

const parentSessionId = sessionId("parent-session");
const childSessionId = sessionId("child-session");

const createTask = (taskStore: SubagentsTaskStore) =>
	taskStore.createTask({
		id: toDelegationTaskId("task-1"),
		agentId: agentId("build"),
		childSessionId,
		parentSessionId,
		parentToolCallId: toolCallId("delegate-call"),
		parentTurnId: agentTurnId("parent-turn"),
	});

const pluginSessionContext = (sessionSdk: SessionSdkChildFactory) => ({
	executionMode: "interactive" as const,
	sessionId: parentSessionId,
	sessionSdk,
	workspace: "/workspace",
});

test("the Subagents Plugin registers delegate for an available child Agent via the Session SDK", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	const workspace = "/workspace";
	const configStore = createConfigStore({
		configRoot: workspace,
		homeRoot: workspace,
	});
	const runtime = await loadPlugins({
		bundledPlugins: [
			{ factory: createSubagentsPluginFactory({ taskStore }), id: "subagents" },
		],
		cliPaths: [],
		config: {
			configStore,
			cwd: workspace,
			homeRoot: workspace,
			workspace,
		} satisfies ConfigRuntime,
	});
	const sessionSdk = fromPartial<SessionSdkChildFactory>({
		getAgentCatalog: async () => [
			{ id: agentId("scout"), isAvailable: true, role: "subagent" },
		],
	});
	const context = fromPartial<PluginBeforeAgentTurnContext>({
		agentId: agentId("build"),
		sessionId: parentSessionId,
		sessionSdk,
		signal: new AbortController().signal,
		turnId: agentTurnId("plugin-turn"),
		workspace,
	});
	try {
		const tools = await runtime.resolveToolsForTurn(context);
		expect(tools.map(({ name }) => name)).toContain("delegate");
	} finally {
		await runtime.shutdown();
		taskStore.close();
	}
});

test("a durable Subagents report is idempotently delivered through the public Session SDK", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	const deliveryAttempted = Promise.withResolvers<void>();
	const deliveries: { idempotencyKey: string; text: string }[] = [];
	try {
		const task = createTask(taskStore);
		taskStore.settleTask({
			outcome: { kind: "result", report: { summary: "Finished" } },
			taskId: task.id,
		});
		const sessionSdk = fromPartial<SessionSdkChildFactory>({
			deliverToSession: async (
				recipient: string,
				input: SessionSdkDelivery
			) => {
				expect(recipient).toBe(parentSessionId);
				deliveries.push(input);
				deliveryAttempted.resolve();
				return {
					disposition: "queued",
					messageId: sessionMessageId("delivered-report"),
					rejected: false,
					submissionId: toSubmissionId("report-delivery"),
				};
			},
		});
		getSubagentsTaskCoordinator(taskStore).onSessionStart(
			pluginSessionContext(sessionSdk)
		);
		await deliveryAttempted.promise;
		await Bun.sleep(0);

		expect(deliveries).toEqual([
			{
				idempotencyKey: `subagents-report-${task.id}`,
				text: expect.stringContaining('"summary": "Finished"'),
			},
		]);
		expect(taskStore.listPendingReports(parentSessionId)).toEqual([]);
	} finally {
		taskStore.close();
	}
});

test("concurrent task completions deliver durable reports in FIFO order", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:", {
		now: () => 1_700_000_000_000,
	});
	const firstDeliveryStarted = Promise.withResolvers<void>();
	const releaseFirstDelivery = Promise.withResolvers<void>();
	const deliveries: string[] = [];
	let firstSettlement: Promise<boolean> | undefined;
	let secondSettlement: Promise<boolean> | undefined;
	try {
		const firstTask = taskStore.createTask({
			id: toDelegationTaskId("task-z"),
			agentId: agentId("build"),
			childSessionId,
			parentSessionId,
			parentToolCallId: toolCallId("delegate-call-z"),
			parentTurnId: agentTurnId("parent-turn-z"),
		});
		const secondTask = taskStore.createTask({
			id: toDelegationTaskId("task-a"),
			agentId: agentId("build"),
			childSessionId: sessionId("child-session-a"),
			parentSessionId,
			parentToolCallId: toolCallId("delegate-call-a"),
			parentTurnId: agentTurnId("parent-turn-a"),
		});
		const sessionSdk = fromPartial<SessionSdkChildFactory>({
			deliverToSession: async (
				_recipient: string,
				input: SessionSdkDelivery
			) => {
				deliveries.push(input.idempotencyKey);
				if (deliveries.length === 1) {
					firstDeliveryStarted.resolve();
					await releaseFirstDelivery.promise;
				}
				return {
					disposition: "queued",
					messageId: sessionMessageId(`delivered-report-${deliveries.length}`),
					rejected: false,
					submissionId: toSubmissionId(`report-delivery-${deliveries.length}`),
				};
			},
		});
		const coordinator = getSubagentsTaskCoordinator(taskStore);
		coordinator.onSessionStart(pluginSessionContext(sessionSdk));
		await Bun.sleep(0);

		firstSettlement = coordinator.settleTask(firstTask.id, {
			kind: "result",
			report: { summary: "First" },
		});
		secondSettlement = coordinator.settleTask(secondTask.id, {
			kind: "result",
			report: { summary: "Second" },
		});
		await firstDeliveryStarted.promise;

		expect(deliveries).toEqual([`subagents-report-${firstTask.id}`]);
		releaseFirstDelivery.resolve();
		await Promise.all([firstSettlement, secondSettlement]);

		expect(deliveries).toEqual([
			`subagents-report-${firstTask.id}`,
			`subagents-report-${secondTask.id}`,
		]);
		expect(taskStore.listPendingReports(parentSessionId)).toEqual([]);
	} finally {
		releaseFirstDelivery.resolve();
		await Promise.allSettled(
			[firstSettlement, secondSettlement].filter(
				(settlement): settlement is Promise<boolean> => settlement !== undefined
			)
		);
		taskStore.close();
	}
});

test("a rejected SDK delivery leaves the durable report available for retry", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	const deliveryAttempted = Promise.withResolvers<void>();
	try {
		const task = createTask(taskStore);
		const report = taskStore.settleTask({
			outcome: { kind: "result", report: { summary: "Retry me" } },
			taskId: task.id,
		});
		if (report === null) {
			throw new Error("Expected a durable report to be committed.");
		}
		const sessionSdk = fromPartial<SessionSdkChildFactory>({
			deliverToSession: async () => {
				deliveryAttempted.resolve();
				return { reason: "Parent is unavailable.", rejected: true };
			},
		});
		getSubagentsTaskCoordinator(taskStore).onSessionStart(
			pluginSessionContext(sessionSdk)
		);
		await deliveryAttempted.promise;
		await Bun.sleep(0);

		expect(taskStore.listPendingReports(parentSessionId)).toEqual([report]);
	} finally {
		taskStore.close();
	}
});

test("active Subagents tasks do not pin the parent Session view and cancel on shutdown", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	let parentViewOpened = false;
	let childInterrupted = false;
	let childHandleDisposed = false;
	let childSdkDisposed = false;
	const childHandle = fromPartial<SessionSdkHandle>({
		dispose: async () => {
			childHandleDisposed = true;
		},
		interrupt: async () => {
			childInterrupted = true;
			return { approvalsSettled: 0, kind: "none", recalled: [] };
		},
		onEvent: () => () => undefined,
		prompt: async () => ({
			disposition: "queued",
			messageId: sessionMessageId("child-prompt"),
			rejected: false,
			submissionId: toSubmissionId("child-prompt"),
		}),
	});
	const childSdk = fromPartial<SessionSdk>({
		dispose: async () => {
			childSdkDisposed = true;
		},
		createEmptySession: async () => childSessionId,
		openSession: async () => childHandle,
	});
	const parentSdk = fromPartial<SessionSdkChildFactory>({
		createChildSdk: async () => childSdk,
		openSession: async () => {
			parentViewOpened = true;
			return fromPartial<SessionSdkHandle>({ dispose: async () => undefined });
		},
	});
	const coordinator = getSubagentsTaskCoordinator(taskStore);
	coordinator.onSessionStart(pluginSessionContext(parentSdk));

	try {
		const started = await coordinator.startTask({
			agentId: agentId("build"),
			parentSessionId,
			parentToolCallId: toolCallId("delegate-call"),
			parentTurnId: agentTurnId("parent-turn"),
			prompt: "Inspect the repository.",
			sessionSdk: parentSdk,
		});
		expect(parentViewOpened).toBe(false);

		await coordinator.onSessionShutdown(pluginSessionContext(parentSdk));

		expect(taskStore.getTask(started.taskId)).toMatchObject({
			outcome: {
				kind: "cancelled",
				reason: expect.stringContaining("parent Session closed"),
			},
			status: "cancelled",
		});
		expect(childInterrupted).toBe(true);
		expect(childHandleDisposed).toBe(true);
		expect(childSdkDisposed).toBe(true);
	} finally {
		await taskStore.close();
	}
});

test("awaiting-report children survive recovery and parent shutdown for explicit result submission", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	let childRecoveryStarted = false;
	try {
		const task = createTask(taskStore);
		expect(taskStore.markAwaitingReport(task.id)).toBe(true);
		const sessionSdk = fromPartial<SessionSdkChildFactory>({
			createChildSdk: async () => {
				childRecoveryStarted = true;
				throw new Error("Awaiting-report children must not auto-resume.");
			},
		});
		const context = pluginSessionContext(sessionSdk);
		const coordinator = getSubagentsTaskCoordinator(taskStore);
		coordinator.onSessionStart(context);

		expect(childRecoveryStarted).toBe(false);
		expect(taskStore.getTask(task.id)).toMatchObject({
			outcome: null,
			status: "awaiting_report",
		});

		await coordinator.onSessionShutdown(context);

		expect(taskStore.getTask(task.id)).toMatchObject({
			outcome: null,
			status: "awaiting_report",
		});
		expect(
			await coordinator.settleTask(task.id, {
				kind: "result",
				report: { summary: "Explicitly continued." },
			})
		).toBe(true);
		expect(taskStore.getTask(task.id)).toMatchObject({
			outcome: { kind: "result", report: { summary: "Explicitly continued." } },
			status: "succeeded",
		});
		expect(taskStore.listPendingReports(parentSessionId)).toHaveLength(1);
	} finally {
		taskStore.close();
	}
});

test("recovery marks an abandoned child interrupted without auto-continuing it", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	const deliveryAttempted = Promise.withResolvers<void>();
	let openOptions:
		| Readonly<{ autoContinue?: boolean; view?: boolean }>
		| undefined;
	try {
		const task = createTask(taskStore);
		const childHandle = fromPartial<SessionSdkHandle>({
			dispose: async () => undefined,
		});
		const childSdk = fromPartial<SessionSdk>({
			dispose: async () => undefined,
			openSession: async (
				_sessionId: string,
				options?: Readonly<{ autoContinue?: boolean; view?: boolean }>
			) => {
				openOptions = options;
				return childHandle;
			},
		});
		const parentSdk = fromPartial<SessionSdkChildFactory>({
			createChildSdk: async () => childSdk,
			deliverToSession: async () => {
				deliveryAttempted.resolve();
				return {
					disposition: "queued",
					messageId: sessionMessageId("interrupted-report"),
					rejected: false,
					submissionId: toSubmissionId("interrupted-report-delivery"),
				};
			},
		});
		getSubagentsTaskCoordinator(taskStore).onSessionStart(
			pluginSessionContext(parentSdk)
		);
		await deliveryAttempted.promise;

		expect(openOptions).toEqual({ autoContinue: false, view: true });
		expect(taskStore.getTask(task.id)).toMatchObject({
			outcome: {
				kind: "interrupted",
				reason: expect.stringContaining("outcome is unknown"),
			},
			status: "interrupted",
		});
	} finally {
		taskStore.close();
	}
});

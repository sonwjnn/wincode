import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { toSubmissionId } from "@wincode/agent-core";
import type {
	SessionRuntimeOptions,
	SessionSdk,
	SessionSdkCapabilityCeiling,
	SessionSdkDelivery,
	SessionSdkHandle,
	SessionSdkOperations,
} from "@wincode/coding-agent";
import {
	createSubagentsTaskStore,
	getSubagentsTaskCoordinator,
	type SubagentsTaskStore,
	toDelegationTaskId,
} from "../src/plugin";
import {
	agentId,
	agentTurnId,
	sessionId,
	sessionMessageId,
	toolCallId,
} from "./identifiers";

const parentSessionId = sessionId("parent-session");
const childSessionId = sessionId("child-session");
const pluginPath = "/plugins/subagents.ts";

const createTask = (
	taskStore: SubagentsTaskStore,
	capabilityCeiling?: SessionSdkCapabilityCeiling
) =>
	taskStore.createTask({
		id: toDelegationTaskId("task-1"),
		agentId: agentId("build"),
		...(capabilityCeiling === undefined ? {} : { capabilityCeiling }),
		childSessionId,
		parentSessionId,
		parentToolCallId: toolCallId("delegate-call"),
		parentTurnId: agentTurnId("parent-turn"),
	});

const pluginSessionContext = (sessionSdk: SessionSdkOperations) => ({
	executionMode: "interactive" as const,
	sessionId: parentSessionId,
	sessionSdk,
	workspace: "/workspace",
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
		const sessionSdk = fromPartial<SessionSdkOperations>({
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
		getSubagentsTaskCoordinator(taskStore, pluginPath).onSessionStart(
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
		const sessionSdk = fromPartial<SessionSdkOperations>({
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
		const coordinator = getSubagentsTaskCoordinator(taskStore, pluginPath);
		coordinator.onSessionStart(pluginSessionContext(sessionSdk));
		await Bun.sleep(0);

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
		const sessionSdk = fromPartial<SessionSdkOperations>({
			deliverToSession: async () => {
				deliveryAttempted.resolve();
				return { reason: "Parent is unavailable.", rejected: true };
			},
		});
		getSubagentsTaskCoordinator(taskStore, pluginPath).onSessionStart(
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
			return { kind: "none", recalled: [] };
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
	const parentSdk = fromPartial<SessionSdkOperations>({
		createSessionRuntime: async () => childSdk,
		openSession: async () => {
			parentViewOpened = true;
			return fromPartial<SessionSdkHandle>({ dispose: async () => undefined });
		},
	});
	const coordinator = getSubagentsTaskCoordinator(taskStore, pluginPath);
	coordinator.onSessionStart(pluginSessionContext(parentSdk));

	try {
		const started = await coordinator.startTask({
			agentId: agentId("build"),
			pluginPath,
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

test("task persistence uses the child runtime's capability ceiling snapshot", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	const runtimeCreationStarted = Promise.withResolvers<void>();
	const releaseRuntimeCreation = Promise.withResolvers<void>();
	const tools = ["read"];
	let runtimeCapabilityCeiling: SessionSdkCapabilityCeiling | undefined;
	const childHandle = fromPartial<SessionSdkHandle>({
		dispose: async () => undefined,
		interrupt: async () => ({ kind: "none", recalled: [] }),
		onEvent: () => () => undefined,
		prompt: async () => ({
			disposition: "queued",
			messageId: sessionMessageId("snapshot-child-prompt"),
			rejected: false,
			submissionId: toSubmissionId("snapshot-child-prompt"),
		}),
	});
	const childSdk = fromPartial<SessionSdk>({
		dispose: async () => undefined,
		createEmptySession: async () => childSessionId,
		openSession: async () => childHandle,
	});
	const parentSdk = fromPartial<SessionSdkOperations>({
		createSessionRuntime: async (options?: SessionRuntimeOptions) => {
			const requestedCeiling = options?.capabilityCeiling;
			runtimeCapabilityCeiling =
				requestedCeiling === undefined
					? undefined
					: { tools: [...requestedCeiling.tools] };
			runtimeCreationStarted.resolve();
			await releaseRuntimeCreation.promise;
			return childSdk;
		},
	});
	const coordinator = getSubagentsTaskCoordinator(taskStore, pluginPath);
	const context = pluginSessionContext(parentSdk);
	coordinator.onSessionStart(context);

	try {
		const startingTask = coordinator.startTask({
			agentId: agentId("build"),
			capabilityCeiling: { tools },
			pluginPath,
			parentSessionId,
			parentToolCallId: toolCallId("snapshot-delegate-call"),
			parentTurnId: agentTurnId("snapshot-parent-turn"),
			prompt: "Inspect the repository.",
			sessionSdk: parentSdk,
		});
		await runtimeCreationStarted.promise;
		tools.push("write");
		releaseRuntimeCreation.resolve();
		const started = await startingTask;

		expect(runtimeCapabilityCeiling).toEqual({ tools: ["read"] });
		expect(taskStore.getTask(started.taskId)?.capabilityCeiling).toEqual(
			runtimeCapabilityCeiling
		);
		await coordinator.onSessionShutdown(context);
	} finally {
		releaseRuntimeCreation.resolve();
		await taskStore.close();
	}
});

test("awaiting-report children survive recovery and parent shutdown for explicit result submission", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	let childRecoveryStarted = false;
	try {
		const task = createTask(taskStore);
		expect(taskStore.markAwaitingReport(task.id)).toBe(true);
		const sessionSdk = fromPartial<SessionSdkOperations>({
			createSessionRuntime: async () => {
				childRecoveryStarted = true;
				throw new Error("Awaiting-report children must not auto-resume.");
			},
		});
		const context = pluginSessionContext(sessionSdk);
		const coordinator = getSubagentsTaskCoordinator(taskStore, pluginPath);
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
	let runtimeOptions: SessionRuntimeOptions | undefined;
	const capabilityCeiling: SessionSdkCapabilityCeiling = { tools: ["read"] };
	try {
		const task = createTask(taskStore, capabilityCeiling);
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
		const parentSdk = fromPartial<SessionSdkOperations>({
			createSessionRuntime: async (options?: SessionRuntimeOptions) => {
				runtimeOptions = options;
				return childSdk;
			},
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
		getSubagentsTaskCoordinator(taskStore, pluginPath).onSessionStart(
			pluginSessionContext(parentSdk)
		);
		await deliveryAttempted.promise;

		expect(openOptions).toEqual({ autoContinue: false, view: true });
		expect(runtimeOptions).toEqual({
			capabilityCeiling,
			pluginPaths: [pluginPath],
		});
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

test("recovery reports an interrupted task when its child Session cannot be reopened", async () => {
	const taskStore = await createSubagentsTaskStore(":memory:");
	const reportDeliveryAttempted = Promise.withResolvers<void>();
	try {
		const task = createTask(taskStore);
		const sessionSdk = fromPartial<SessionSdkOperations>({
			createSessionRuntime: async () => {
				throw new Error("Child runtime initialization failed.");
			},
			deliverToSession: async () => {
				reportDeliveryAttempted.resolve();
				throw new Error("Parent Session is unavailable.");
			},
		});
		getSubagentsTaskCoordinator(taskStore, pluginPath).onSessionStart(
			pluginSessionContext(sessionSdk)
		);
		await reportDeliveryAttempted.promise;

		expect(taskStore.getTask(task.id)).toMatchObject({
			outcome: {
				kind: "interrupted",
				reason: expect.stringContaining("child Session could not be reopened"),
			},
			status: "interrupted",
		});
		const pendingReports = taskStore.listPendingReports(parentSessionId);
		expect(pendingReports).toHaveLength(1);
		expect(pendingReports[0]?.outcome).toMatchObject({
			kind: "interrupted",
		});
	} finally {
		taskStore.close();
	}
});

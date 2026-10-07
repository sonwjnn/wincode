import { createSubagentTaskWaiters } from "@wincode/subagents";
import type {
	DelegationReportEnvelope,
	DelegationTask,
	DelegationTaskOutcome,
} from "@/modules/sessions/delegation/types";
import type {
	SessionDelegationPort,
	SessionDelegationRuntimePorts,
	SessionDelegationSession,
	SessionHost,
} from "@/modules/sessions/host/types";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import { SessionInUseError } from "@/modules/sessions/storage/session-writer-lock";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";
import { getSharedSubagentsTaskStore, type SubagentsTaskStore } from "./store";

const recoveredStores = new WeakMap<SessionStore, Promise<void>>();
type PublishTask = (
	task: DelegationTask,
	report?: DelegationReportEnvelope
) => void;

const importLegacyTasks = async (
	store: SessionStore,
	taskStore: SubagentsTaskStore
): Promise<void> => {
	const tasks = await store.listAllDelegationTasks();
	const parents = new Set(tasks.map((task) => task.parentSessionId));
	const pendingReports = new Set(
		(
			await Promise.all(
				[...parents].map((sessionId) =>
					store.listPendingDelegationReports(sessionId)
				)
			)
		).flatMap((reports) => reports.map((report) => report.taskId))
	);
	for (const task of tasks) {
		taskStore.importTask(task, pendingReports.has(task.id));
	}
};

const acquireAvailableSessionWriter = async (
	store: SessionStore,
	sessionId: SessionId
) => {
	try {
		return await store.acquireSessionWriter(sessionId);
	} catch (error) {
		if (error instanceof SessionInUseError) {
			return null;
		}
		throw error;
	}
};

const recoverUnownedTask = async (
	task: DelegationTask,
	store: SessionStore,
	taskStore: SubagentsTaskStore,
	activeTaskIds: readonly DelegationTaskId[],
	publishTask: PublishTask
): Promise<void> => {
	if (activeTaskIds.includes(task.id)) {
		return;
	}
	const parentLock = await acquireAvailableSessionWriter(
		store,
		task.parentSessionId
	);
	if (parentLock === null) {
		return;
	}
	try {
		const childLock = await acquireAvailableSessionWriter(
			store,
			task.childSessionId
		);
		if (childLock === null) {
			return;
		}
		try {
			const outcome: DelegationTaskOutcome = {
				kind: "interrupted",
				reason:
					"The process stopped before a result was committed; the task outcome is unknown.",
			};
			const report = taskStore.settleTask({ outcome, taskId: task.id });
			const legacyTask = await store.getDelegationTask(task.id);
			const legacyReport =
				legacyTask === null
					? null
					: await store.settleDelegationTask({ outcome, taskId: task.id });
			const settled = taskStore.getTask(task.id);
			if (settled !== null) {
				publishTask(settled, legacyReport ?? undefined);
			} else if (report !== null && legacyReport !== null) {
				publishTask(task, legacyReport);
			}
		} finally {
			await childLock.release();
		}
	} finally {
		await parentLock.release();
	}
};

const recoverUnownedTasks = async (
	store: SessionStore,
	taskStore: SubagentsTaskStore,
	activeTaskIds: readonly DelegationTaskId[],
	publishTask: PublishTask
): Promise<void> => {
	for (const task of taskStore.listActiveTasks()) {
		await recoverUnownedTask(
			task,
			store,
			taskStore,
			activeTaskIds,
			publishTask
		);
	}
};

/** Creates the process-lifetime task coordinator for the Subagents Plugin. */
export const createSubagentTaskRuntime = (
	{ emitTaskEvent, requestHostUnload }: SessionDelegationRuntimePorts,
	taskStore: SubagentsTaskStore = getSharedSubagentsTaskStore()
): SessionDelegationPort => {
	const hosts = new Map<SessionId, SessionHost>();
	const openingHosts = new Set<SessionId>();
	const pendingReports = new Map<SessionId, DelegationReportEnvelope[]>();
	const onHostOpening: SessionDelegationPort["onHostOpening"] = (sessionId) => {
		openingHosts.add(sessionId);
	};
	const onHostOpened: SessionDelegationPort["onHostOpened"] = (
		sessionId,
		host
	) => {
		openingHosts.delete(sessionId);
		hosts.set(sessionId, host);
		const reports = pendingReports.get(sessionId);
		pendingReports.delete(sessionId);
		for (const report of reports ?? []) {
			host.publishDelegationReport(report);
		}
	};
	const onHostClosed: SessionDelegationPort["onHostClosed"] = (sessionId) => {
		openingHosts.delete(sessionId);
		hosts.delete(sessionId);
		pendingReports.delete(sessionId);
	};
	const taskWaiters = createSubagentTaskWaiters<DelegationTaskId, SessionId>();

	const publishTask = (
		task: DelegationTask,
		report?: DelegationReportEnvelope
	): void => {
		emitTaskEvent(task, report);
		if (task.status !== "active") {
			taskWaiters.finishTask(task.id);
			requestHostUnload(task.childSessionId);
		}
		if (report !== undefined) {
			const parentSessionId = report.parentSessionId;
			const host = hosts.get(parentSessionId);
			if (host !== undefined) {
				host.publishDelegationReport(report);
			} else if (openingHosts.has(parentSessionId)) {
				const reports = pendingReports.get(parentSessionId) ?? [];
				reports.push(report);
				pendingReports.set(parentSessionId, reports);
			}
		}
	};

	const recoverStore = async (store: SessionStore): Promise<void> => {
		let recovery = recoveredStores.get(store);
		if (recovery === undefined) {
			recovery = (async () => {
				await importLegacyTasks(store, taskStore);
				await recoverUnownedTasks(
					store,
					taskStore,
					taskWaiters.activeTaskIds(),
					publishTask
				);
			})();
			recoveredStores.set(store, recovery);
		}
		try {
			await recovery;
		} catch (error) {
			recoveredStores.delete(store);
			throw error;
		}
	};

	const cancelActiveTasks: SessionDelegationPort["cancelActiveTasks"] = async (
		sessions: readonly SessionDelegationSession[]
	): Promise<void> => {
		for (const { capabilities, sessionId } of sessions) {
			const sessionStore = capabilities.getStore();
			const task = taskStore.getTaskForChild(sessionId);
			if (task?.status !== "active") {
				continue;
			}
			const outcome: DelegationTaskOutcome = {
				kind: "cancelled",
				reason: "Application shutdown cancelled the delegated task.",
			};
			const report = taskStore.settleTask({ outcome, taskId: task.id });
			const legacyReport = await sessionStore.settleDelegationTask({
				outcome,
				taskId: task.id,
			});
			const settled = taskStore.getTask(task.id);
			if (settled !== null) {
				publishTask(settled, legacyReport ?? report ?? undefined);
			}
		}
	};

	const getTaskForChild: SessionDelegationPort["getTaskForChild"] = async (
		childSessionId
	) => taskStore.getTaskForChild(childSessionId);
	const hasActiveTasks: SessionDelegationPort["hasActiveTasks"] = async (
		parentSessionId
	) =>
		taskStore
			.listTasks(parentSessionId)
			.some((task) => task.status === "active");
	const isTaskActive: SessionDelegationPort["isTaskActive"] = async (taskId) =>
		taskStore.getTask(taskId)?.status === "active";

	const waitForTasks: SessionDelegationPort["waitForTasks"] = async (
		parentSessionId
	) => {
		const tasks = await taskWaiters.waitForDescendants<DelegationTask>({
			isActive: (task) => task.status === "active",
			listTasks: async (sessionId) => taskStore.listTasks(sessionId),
			parentSessionId,
		});
		return [...tasks];
	};

	return Object.freeze({
		activeTaskIds: taskWaiters.activeTaskIds,
		cancelActiveTasks,
		onHostClosed,
		onHostOpened,
		onHostOpening,
		finishAllTasks: () => {
			for (const taskId of taskWaiters.activeTaskIds()) {
				taskWaiters.finishTask(taskId);
			}
		},
		finishTask: taskWaiters.finishTask,
		getTaskForChild,
		hasActiveTasks,
		isTaskActive,
		publishTask,
		recoverStore,
		registerTask: (task: DelegationTask) => {
			taskWaiters.registerTask(task.id);
			publishTask(task);
		},
		waitForTasks,
	});
};

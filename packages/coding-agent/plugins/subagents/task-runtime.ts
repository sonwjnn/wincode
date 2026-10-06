import { createSubagentTaskWaiters } from "@wincode/subagents";
import type {
	DelegationReportEnvelope,
	DelegationTask,
} from "@/modules/sessions/delegation/types";
import type {
	SessionDelegationPort,
	SessionDelegationRuntimePorts,
	SessionDelegationSession,
	SessionHost,
} from "@/modules/sessions/host/types";
import type { SessionStore } from "@/modules/sessions/storage/session-store";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";

const recoveredStores = new WeakMap<SessionStore, Promise<void>>();

/** Creates the process-lifetime task coordinator for the Subagents Plugin. */
export const createSubagentTaskRuntime = ({
	emitTaskEvent,
	requestHostUnload,
}: SessionDelegationRuntimePorts): SessionDelegationPort => {
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

	const recoverStore = async (store: SessionStore): Promise<void> => {
		let recovery = recoveredStores.get(store);
		if (recovery === undefined) {
			recovery = store.recoverUncleanDelegationTasks(
				taskWaiters.activeTaskIds()
			);
			recoveredStores.set(store, recovery);
		}
		try {
			await recovery;
		} catch (error) {
			recoveredStores.delete(store);
			throw error;
		}
	};

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

	const cancelActiveTasks: SessionDelegationPort["cancelActiveTasks"] = async (
		sessions: readonly SessionDelegationSession[]
	): Promise<void> => {
		for (const { capabilities, sessionId } of sessions) {
			const store = capabilities.getStore();
			const task = await store.getDelegationTaskForChild(sessionId);
			if (task?.status !== "active") {
				continue;
			}
			const report = await store.settleDelegationTask({
				outcome: {
					kind: "cancelled",
					reason: "Application shutdown cancelled the delegated task.",
				},
				taskId: task.id,
			});
			if (report === null) {
				continue;
			}
			const settled = await store.getDelegationTask(task.id);
			if (settled !== null) {
				publishTask(settled, report);
			}
		}
	};

	const getTaskForChild: SessionDelegationPort["getTaskForChild"] = (
		store,
		childSessionId
	) => store.getDelegationTaskForChild(childSessionId);
	const hasActiveTasks: SessionDelegationPort["hasActiveTasks"] = async (
		store,
		parentSessionId
	) =>
		(await store.listDelegationTasks(parentSessionId)).some(
			(task) => task.status === "active"
		);
	const isTaskActive: SessionDelegationPort["isTaskActive"] = async (
		store,
		taskId
	) => (await store.getDelegationTask(taskId))?.status === "active";

	const waitForTasks: SessionDelegationPort["waitForTasks"] = async (
		store,
		parentSessionId
	) => {
		const tasks = await taskWaiters.waitForDescendants<DelegationTask>({
			isActive: (task) => task.status === "active",
			listTasks: (sessionId) => store.listDelegationTasks(sessionId),
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

import type { DelegationTaskId, SessionId } from "@/shared/identifiers";
import type {
	DelegationReportEnvelope,
	DelegationTask,
} from "../delegation/types";
import type { SessionStore } from "../storage/session-store";
import { createSessionHost } from "./session-host";
import type {
	SessionCapabilities,
	SessionHost,
	SessionHostManager,
	SessionHostManagerEvent,
	SessionHostOptions,
} from "./types";

type ManagedHostEntry = {
	capabilities: SessionCapabilities;
	closing: Promise<void> | undefined;
	unloadCheck: Promise<void> | undefined;
	delegatedTaskId: DelegationTaskId | null;
	host: SessionHost | undefined;
	pendingApprovalCount: number;
	opening: Promise<SessionHost>;
	sessionId: SessionId;
	unsubscribeEvents: (() => void) | undefined;
	unsubscribeSnapshot: (() => void) | undefined;
	views: number;
};

type DelegatedTaskWaiter = Readonly<{
	parentSessionId: SessionId;
	promise: Promise<void>;
	resolve: () => void;
}>;

const recoveredStores = new WeakMap<SessionStore, Promise<void>>();
let interactiveManager: SessionHostManager | undefined;

const recoverStore = async (
	store: SessionStore,
	excludeTaskIds: readonly DelegationTaskId[] = []
): Promise<void> => {
	let recovery = recoveredStores.get(store);
	if (recovery === undefined) {
		recovery = store.recoverUncleanDelegationTasks(excludeTaskIds);
		recoveredStores.set(store, recovery);
	}
	try {
		await recovery;
	} catch (error) {
		recoveredStores.delete(store);
		throw error;
	}
};

export const createSessionHostManager = (): SessionHostManager => {
	const entries = new Map<SessionId, ManagedHostEntry>();
	const taskWaiters = new Map<DelegationTaskId, DelegatedTaskWaiter>();
	const eventListeners = new Set<(event: SessionHostManagerEvent) => void>();
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | undefined;

	const emit = (event: SessionHostManagerEvent): void => {
		for (const listener of [...eventListeners]) {
			try {
				listener(event);
			} catch {
				// One consumer cannot interrupt another session's runtime.
			}
		}
	};
	const updateApprovalNotice = (
		entry: ManagedHostEntry,
		host: SessionHost
	): void => {
		const pendingApprovalCount = host.agentSession
			.getSnapshot()
			.approvals.reduce(
				(count, approval) => count + (approval.decision === undefined ? 1 : 0),
				0
			);
		if (pendingApprovalCount === entry.pendingApprovalCount) {
			return;
		}
		entry.pendingApprovalCount = pendingApprovalCount;
		emit({
			pendingApprovalCount,
			sessionId: entry.sessionId,
			type: "session-approval-notice",
		});
	};
	const finishDelegatedTask = (taskId: DelegationTaskId): void => {
		const waiter = taskWaiters.get(taskId);
		if (waiter === undefined) {
			return;
		}
		taskWaiters.delete(taskId);
		waiter.resolve();
	};
	const canUnload = (host: SessionHost): boolean => {
		const snapshot = host.agentSession.getSnapshot();
		if (snapshot.turnActive || snapshot.isCompacting) {
			return false;
		}
		if (
			snapshot.executions.length > 0 ||
			snapshot.approvals.some(({ decision }) => decision === undefined) ||
			snapshot.queuedSubmissions.length > 0 ||
			snapshot.steeringMessages.length > 0 ||
			snapshot.error !== null
		) {
			return false;
		}
		return true;
	};
	const maybeUnload = async (entry: ManagedHostEntry): Promise<void> => {
		if (shuttingDown) {
			return;
		}
		if (entry.unloadCheck !== undefined) {
			await entry.unloadCheck;
			return;
		}
		const host = entry.host;
		if (
			entry.views > 0 ||
			host === undefined ||
			entry.closing !== undefined ||
			!canUnload(host)
		) {
			return;
		}
		const unloadCheck = Promise.withResolvers<void>();
		entry.unloadCheck = unloadCheck.promise;
		try {
			const delegatedTaskId = entry.delegatedTaskId;
			const store = entry.capabilities.getStore();
			const hasActiveDelegation =
				delegatedTaskId === null
					? (await store.listDelegationTasks(entry.sessionId)).some(
							(task) => task.status === "active"
						)
					: (await store.getDelegationTask(delegatedTaskId))?.status ===
						"active";
			if (
				hasActiveDelegation ||
				entry.views > 0 ||
				entry.host !== host ||
				entry.closing !== undefined ||
				!canUnload(host)
			) {
				return;
			}
			const closing = host.shutdown();
			entry.closing = closing;
			try {
				await closing;
			} finally {
				entry.unsubscribeEvents?.();
				entry.unsubscribeSnapshot?.();
				if (entries.get(entry.sessionId) === entry) {
					entries.delete(entry.sessionId);
				}
			}
		} finally {
			if (entry.unloadCheck === unloadCheck.promise) {
				entry.unloadCheck = undefined;
			}
			unloadCheck.resolve();
		}
	};
	const createEntry = (
		capabilities: SessionCapabilities,
		sessionId: SessionId,
		executionMode: SessionHostOptions["executionMode"],
		delegatedTaskId: DelegationTaskId | null
	): ManagedHostEntry => {
		const opened = Promise.withResolvers<SessionHost>();
		const entry: ManagedHostEntry = {
			capabilities,
			delegatedTaskId,
			unloadCheck: undefined,
			closing: undefined,
			pendingApprovalCount: 0,
			host: undefined,
			opening: opened.promise,
			sessionId,
			unsubscribeEvents: undefined,
			unsubscribeSnapshot: undefined,
			views: 0,
		};
		entries.set(sessionId, entry);
		void createSessionHost({
			capabilities,
			...(executionMode === undefined ? {} : { executionMode }),
			sessionId,
		} satisfies SessionHostOptions).then(
			(host) => {
				entry.host = host;
				updateApprovalNotice(entry, host);
				entry.unsubscribeEvents = host.onEvent((event) =>
					emit({ event, sessionId, type: "agent-turn-event" })
				);
				entry.unsubscribeSnapshot = host.subscribe(() => {
					updateApprovalNotice(entry, host);
					void maybeUnload(entry);
				});
				opened.resolve(host);
			},
			(error: unknown) => {
				if (entries.get(sessionId) === entry) {
					entries.delete(sessionId);
				}
				opened.reject(error);
			}
		);
		return entry;
	};
	const waitForEntryTransition = async (
		entry: ManagedHostEntry | undefined
	): Promise<boolean> => {
		if (entry?.unloadCheck !== undefined) {
			await entry.unloadCheck;
			return true;
		}
		if (entry?.closing !== undefined) {
			await entry.closing.catch(() => undefined);
			return true;
		}
		return false;
	};
	const releaseViewReference = (
		entry: ManagedHostEntry,
		view: boolean
	): void => {
		if (view) {
			entry.views = Math.max(0, entry.views - 1);
		}
	};
	const awaitEntryOpening = async (
		entry: ManagedHostEntry,
		view: boolean
	): Promise<void> => {
		try {
			await entry.opening;
		} catch (error) {
			releaseViewReference(entry, view);
			throw error;
		}
	};
	const getOpenEntry = async (
		capabilities: SessionCapabilities,
		sessionId: SessionId,
		executionMode: SessionHostOptions["executionMode"],
		delegatedTaskId: DelegationTaskId | null,
		view: boolean
	): Promise<ManagedHostEntry> => {
		while (true) {
			const entry = entries.get(sessionId);
			if (entry === undefined) {
				const created = createEntry(
					capabilities,
					sessionId,
					executionMode,
					delegatedTaskId
				);
				if (view) {
					created.views += 1;
				}
				await awaitEntryOpening(created, view);
				return created;
			}
			if (await waitForEntryTransition(entry)) {
				continue;
			}
			entry.delegatedTaskId ??= delegatedTaskId;
			if (view) {
				entry.views += 1;
			}
			await awaitEntryOpening(entry, view);
			if (entry.closing === undefined) {
				return entry;
			}
			releaseViewReference(entry, view);
			await entry.closing.catch(() => undefined);
		}
	};
	const openHost: SessionHostManager["openHost"] = async ({
		capabilities,
		executionMode,
		sessionId,
		view = false,
	}) => {
		await recoverStore(capabilities.getStore(), [...taskWaiters.keys()]);
		if (shuttingDown) {
			throw new Error("The Session Host manager is shutting down.");
		}
		const task = await capabilities
			.getStore()
			.getDelegationTaskForChild(sessionId);
		const entry = await getOpenEntry(
			capabilities,
			sessionId,
			executionMode,
			task?.id ?? null,
			view
		);
		return entry.opening;
	};
	const publishDelegationTask = (
		task: DelegationTask,
		report?: DelegationReportEnvelope
	): void => {
		emit({
			...(report === undefined ? {} : { report }),
			task,
			type: "delegation-task",
		});
		if (task.status !== "active") {
			finishDelegatedTask(task.id);
			const child = entries.get(task.childSessionId);
			if (child !== undefined) {
				void maybeUnload(child);
			}
		}
		if (report !== undefined) {
			const parent = entries.get(report.parentSessionId);
			if (parent !== undefined) {
				void parent.opening
					.then((host) => host.publishDelegationReport(report))
					.catch(() => undefined);
			}
		}
	};
	const releaseView: SessionHostManager["releaseView"] = async (sessionId) => {
		const entry = entries.get(sessionId);
		if (entry === undefined) {
			return;
		}
		entry.views = Math.max(0, entry.views - 1);
		await maybeUnload(entry);
	};
	const waitForDelegatedTasks: SessionHostManager["waitForDelegatedTasks"] =
		async (store, parentSessionId) => {
			while (true) {
				const sessions = [parentSessionId];
				const visitedSessions = new Set<SessionId>();
				const tasks = new Map<DelegationTaskId, DelegationTask>();
				while (sessions.length > 0) {
					const sessionId = sessions.pop();
					if (sessionId === undefined || visitedSessions.has(sessionId)) {
						continue;
					}
					visitedSessions.add(sessionId);
					for (const task of await store.listDelegationTasks(sessionId)) {
						tasks.set(task.id, task);
						sessions.push(task.childSessionId);
					}
				}
				const active = [...tasks.values()].filter(
					(task) => task.status === "active"
				);
				if (active.length === 0) {
					return [...tasks.values()];
				}
				await Promise.all(
					active.map((task) => {
						const waiter = taskWaiters.get(task.id);
						if (waiter === undefined) {
							throw new Error(
								`Active Delegation Task ${task.id} has no live runtime.`
							);
						}
						return waiter.promise;
					})
				);
			}
		};
	const cancelActiveDelegatedTask = async (
		entry: ManagedHostEntry
	): Promise<void> => {
		const store = entry.capabilities.getStore();
		const task = await store.getDelegationTaskForChild(entry.sessionId);
		if (task?.status !== "active") {
			return;
		}
		const report = await store.settleDelegationTask({
			outcome: {
				kind: "cancelled",
				reason: "Application shutdown cancelled the delegated task.",
			},
			taskId: task.id,
		});
		if (report === null) {
			return;
		}
		const settled = await store.getDelegationTask(task.id);
		if (settled !== null) {
			publishDelegationTask(settled, report);
		}
	};
	const cancelActiveDelegatedTasks = async (): Promise<void> => {
		for (const entry of entries.values()) {
			await cancelActiveDelegatedTask(entry);
		}
	};
	const shutdownAll: SessionHostManager["shutdownAll"] = () => {
		if (shutdownPromise !== undefined) {
			return shutdownPromise;
		}
		shuttingDown = true;
		const closing = (async () => {
			const opened = await Promise.allSettled(
				[...entries.values()].map((entry) => entry.opening)
			);
			const hosts = opened.flatMap((result) =>
				result.status === "fulfilled" ? [result.value] : []
			);
			await Promise.allSettled(hosts.map((host) => host.shutdown()));
			await cancelActiveDelegatedTasks();
			for (const taskId of taskWaiters.keys()) {
				finishDelegatedTask(taskId);
			}
			for (const entry of entries.values()) {
				entry.unsubscribeEvents?.();
				entry.unsubscribeSnapshot?.();
			}
			entries.clear();
		})();
		shutdownPromise = closing;
		return closing;
	};

	return {
		finishDelegatedTask,
		onEvent: (listener) => {
			eventListeners.add(listener);
			for (const entry of entries.values()) {
				if (entry.pendingApprovalCount > 0) {
					try {
						listener({
							pendingApprovalCount: entry.pendingApprovalCount,
							sessionId: entry.sessionId,
							type: "session-approval-notice",
						});
					} catch {
						// A replayed notice cannot interrupt another session's runtime.
					}
				}
			}
			return () => eventListeners.delete(listener);
		},
		openHost,
		publishDelegationTask,
		registerDelegatedTask: (task) => {
			if (!taskWaiters.has(task.id)) {
				const waiter = Promise.withResolvers<void>();
				taskWaiters.set(task.id, {
					parentSessionId: task.parentSessionId,
					promise: waiter.promise,
					resolve: waiter.resolve,
				});
			}
			publishDelegationTask(task);
		},
		releaseView,
		shutdownAll,
		waitForDelegatedTasks,
	};
};

export const getInteractiveSessionHostManager = (): SessionHostManager => {
	interactiveManager ??= createSessionHostManager();
	return interactiveManager;
};

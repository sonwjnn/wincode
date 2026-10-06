import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";
import { createSessionHost } from "./session-host";
import type {
	SessionCapabilities,
	SessionDelegationPort,
	SessionDelegationRuntimeFactory,
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
	pluginRuntime?: PluginRuntime;
	pluginSessionContext: Readonly<{ sessionId: string; workspace: string }>;
};

let interactiveManager: SessionHostManager | undefined;

const createNoopDelegationRuntime: SessionDelegationRuntimeFactory = ({
	emitTaskEvent: _emitTaskEvent,
	requestHostUnload: _requestHostUnload,
}) => ({
	activeTaskIds: () => [],
	cancelActiveTasks: async () => undefined,
	finishAllTasks: () => undefined,
	finishTask: () => undefined,
	getTaskForChild: (store, childSessionId) =>
		store.getDelegationTaskForChild(childSessionId),
	hasActiveTasks: async (store, parentSessionId) =>
		(await store.listDelegationTasks(parentSessionId)).some(
			(task) => task.status === "active"
		),
	isTaskActive: async (store, taskId) =>
		(await store.getDelegationTask(taskId))?.status === "active",
	onHostClosed: () => undefined,
	onHostOpened: () => undefined,
	onHostOpening: () => undefined,
	publishTask: () => undefined,
	recoverStore: async () => undefined,
	registerTask: () => undefined,
	waitForTasks: (store, parentSessionId) =>
		store.listDelegationTasks(parentSessionId),
});

export const createSessionHostManager = (
	createDelegationRuntime?: SessionDelegationRuntimeFactory,
	processPluginRuntime?: PluginRuntime
): SessionHostManager => {
	const entries = new Map<SessionId, ManagedHostEntry>();
	const eventListeners = new Set<(event: SessionHostManagerEvent) => void>();
	let delegation: SessionDelegationPort;
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
					? await delegation.hasActiveTasks(store, entry.sessionId)
					: await delegation.isTaskActive(store, delegatedTaskId);
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
				await entry.pluginRuntime?.stopSession(entry.pluginSessionContext);
				entry.unsubscribeEvents?.();
				entry.unsubscribeSnapshot?.();
				delegation.onHostClosed(entry.sessionId);
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
	delegation = (createDelegationRuntime ?? createNoopDelegationRuntime)({
		emitTaskEvent: (task, report) =>
			emit({
				...(report === undefined ? {} : { report }),
				task,
				type: "delegation-task",
			}),
		requestHostUnload: (sessionId) => {
			const entry = entries.get(sessionId);
			if (entry !== undefined) {
				void maybeUnload(entry);
			}
		},
	});
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
			pluginRuntime: capabilities.getPluginRuntime?.() ?? processPluginRuntime,
			pluginSessionContext: {
				sessionId,
				workspace: capabilities.getConfig().workspace,
			},
		};
		entries.set(sessionId, entry);
		delegation.onHostOpening(sessionId);
		const opening = (async () => {
			try {
				await entry.pluginRuntime?.startSession(entry.pluginSessionContext);
			} catch {
				// Plugin lifecycle failures never prevent a Session from opening.
			}
			try {
				return await createSessionHost({
					capabilities,
					...(executionMode === undefined ? {} : { executionMode }),
					sessionId,
				} satisfies SessionHostOptions);
			} catch (error) {
				await entry.pluginRuntime?.stopSession(entry.pluginSessionContext);
				throw error;
			}
		})();
		void opening.then(
			(host) => {
				entry.host = host;
				delegation.onHostOpened(sessionId, host);
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
				delegation.onHostClosed(sessionId);
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
		await delegation.recoverStore(capabilities.getStore());
		if (shuttingDown) {
			throw new Error("The Session Host manager is shutting down.");
		}
		const task = await delegation.getTaskForChild(
			capabilities.getStore(),
			sessionId
		);
		const entry = await getOpenEntry(
			capabilities,
			sessionId,
			executionMode,
			task?.id ?? null,
			view
		);
		return entry.opening;
	};
	const releaseView: SessionHostManager["releaseView"] = async (sessionId) => {
		const entry = entries.get(sessionId);
		if (entry === undefined) {
			return;
		}
		entry.views = Math.max(0, entry.views - 1);
		await maybeUnload(entry);
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
			await Promise.allSettled(
				[...entries.values()].map((entry) =>
					entry.pluginRuntime?.stopSession(entry.pluginSessionContext)
				)
			);
			await delegation.cancelActiveTasks([...entries.values()]);
			for (const entry of entries.values()) {
				if (entry.host !== undefined) {
					delegation.onHostClosed(entry.sessionId);
				}
			}
			delegation.finishAllTasks();
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
		releaseView,
		shutdownAll,
		delegation,
	};
};

export const getInteractiveSessionHostManager = (
	createDelegationRuntime?: SessionDelegationRuntimeFactory,
	pluginRuntime?: PluginRuntime
): SessionHostManager => {
	interactiveManager ??= createSessionHostManager(
		createDelegationRuntime,
		pluginRuntime
	);
	return interactiveManager;
};

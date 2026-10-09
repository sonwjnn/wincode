import type { PluginSessionContext } from "@/modules/plugins/public";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import type { SessionId } from "@/shared/identifiers";
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
	executionMode: SessionHostOptions["executionMode"];
	host: SessionHost | undefined;
	opening: Promise<SessionHost>;
	openingComplete: boolean;
	sessionId: SessionId;
	unsubscribeEvents: (() => void) | undefined;
	unsubscribeSnapshot: (() => void) | undefined;
	unsubscribeBackgroundWork: (() => void) | undefined;
	views: number;
	pluginRuntime?: PluginRuntime;
	pluginSessionContext: PluginSessionContext;
	unloadCheck: Promise<void> | undefined;
};

let interactiveManager: SessionHostManager | undefined;

export const createSessionHostManager = (
	processPluginRuntime?: PluginRuntime
): SessionHostManager => {
	const entries = new Map<SessionId, ManagedHostEntry>();
	let currentPluginRuntime = processPluginRuntime;
	const eventListeners = new Set<(event: SessionHostManagerEvent) => void>();
	let shuttingDown = false;
	let reloadInProgress = false;
	let openRequestsInProgress = 0;
	let sessionWorkAdmissionsInProgress = 0;
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
	const canUnload = (entry: ManagedHostEntry, host: SessionHost): boolean => {
		if (entry.pluginRuntime?.hasBackgroundWork(entry.sessionId) === true) {
			return false;
		}
		const snapshot = host.agentSession.getSnapshot();
		if (snapshot.turnActive || snapshot.isCompacting) {
			return false;
		}
		return !(
			snapshot.executions.length > 0 ||
			snapshot.queuedSubmissions.length > 0 ||
			snapshot.steeringMessages.length > 0 ||
			snapshot.error !== null
		);
	};
	const maybeUnload = async (entry: ManagedHostEntry): Promise<void> => {
		if (shuttingDown || reloadInProgress || !entry.openingComplete) {
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
			!canUnload(entry, host)
		) {
			return;
		}
		const unloadCheck = Promise.withResolvers<void>();
		entry.unloadCheck = unloadCheck.promise;
		try {
			if (
				entry.views > 0 ||
				entry.host !== host ||
				entry.closing !== undefined ||
				!canUnload(entry, host)
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
				entry.unsubscribeBackgroundWork?.();
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
		autoContinue: boolean
	): ManagedHostEntry => {
		const opened = Promise.withResolvers<SessionHost>();
		const sessionSdk = capabilities.getSessionSdk?.();
		const entry: ManagedHostEntry = {
			capabilities,
			closing: undefined,
			executionMode,
			host: undefined,
			opening: opened.promise,
			openingComplete: false,
			sessionId,
			unsubscribeEvents: undefined,
			unsubscribeSnapshot: undefined,
			views: 0,
			unsubscribeBackgroundWork: undefined,
			pluginRuntime: capabilities.getPluginRuntime?.() ?? currentPluginRuntime,
			pluginSessionContext: {
				...(executionMode === undefined ? {} : { executionMode }),
				sessionId,
				...(sessionSdk === undefined ? {} : { sessionSdk }),
				workspace: capabilities.getConfig().workspace,
			},
			unloadCheck: undefined,
		};
		entries.set(sessionId, entry);
		entry.unsubscribeBackgroundWork =
			entry.pluginRuntime?.onBackgroundWorkChange(sessionId, () => {
				void maybeUnload(entry);
			});
		const sessionStart =
			entry.pluginRuntime
				?.startSession(entry.pluginSessionContext)
				.catch(() => undefined) ?? Promise.resolve();
		void sessionStart
			.then(() =>
				createSessionHost({
					autoContinue,
					capabilities,
					...(executionMode === undefined ? {} : { executionMode }),
					sessionId,
				} satisfies SessionHostOptions)
			)
			.then(
				(host) => {
					entry.host = host;
					entry.unsubscribeEvents = host.onEvent((event) =>
						emit({ event, sessionId, type: "agent-turn-event" })
					);
					entry.unsubscribeSnapshot = host.subscribe(() => {
						void maybeUnload(entry);
					});
					entry.openingComplete = true;
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
	const createOpenEntry = async (
		capabilities: SessionCapabilities,
		sessionId: SessionId,
		executionMode: SessionHostOptions["executionMode"],
		view: boolean,
		autoContinue: boolean
	): Promise<ManagedHostEntry> => {
		const entry = createEntry(
			capabilities,
			sessionId,
			executionMode,
			autoContinue
		);
		if (view) {
			entry.views += 1;
		}
		await awaitEntryOpening(entry, view);
		return entry;
	};
	const continuePendingSteering = (entry: ManagedHostEntry): void => {
		const host = entry.host;
		if (host?.getSnapshot().steeringMessages[0]?.status === "pending") {
			host.agentSession.continue();
		}
	};
	const reuseOpenEntry = async (
		entry: ManagedHostEntry,
		view: boolean,
		autoContinue: boolean
	): Promise<ManagedHostEntry | undefined> => {
		if (await waitForEntryTransition(entry)) {
			return;
		}
		if (view) {
			entry.views += 1;
		}
		await awaitEntryOpening(entry, view);
		if (entry.closing !== undefined) {
			releaseViewReference(entry, view);
			await entry.closing.catch(() => undefined);
			return;
		}
		if (autoContinue) {
			continuePendingSteering(entry);
		}
		return entry;
	};
	const getOpenEntry = async (
		capabilities: SessionCapabilities,
		sessionId: SessionId,
		executionMode: SessionHostOptions["executionMode"],
		view: boolean,
		autoContinue: boolean
	): Promise<ManagedHostEntry> => {
		while (true) {
			const entry = entries.get(sessionId);
			if (entry === undefined) {
				return createOpenEntry(
					capabilities,
					sessionId,
					executionMode,
					view,
					autoContinue
				);
			}
			const reusable = await reuseOpenEntry(entry, view, autoContinue);
			if (reusable !== undefined) {
				return reusable;
			}
		}
	};
	const openHost: SessionHostManager["openHost"] = async ({
		autoContinue = true,
		capabilities,
		executionMode,
		sessionId,
		view = false,
	}) => {
		if (shuttingDown) {
			throw new Error("The Session Host manager is shutting down.");
		}
		if (reloadInProgress) {
			throw new Error("Cannot open a Session while resources are reloading.");
		}
		openRequestsInProgress += 1;
		try {
			const entry = await getOpenEntry(
				capabilities,
				sessionId,
				executionMode,
				view,
				autoContinue
			);
			return entry.opening;
		} finally {
			openRequestsInProgress -= 1;
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
			for (const entry of entries.values()) {
				entry.unsubscribeEvents?.();
				entry.unsubscribeSnapshot?.();
				entry.unsubscribeBackgroundWork?.();
			}
			entries.clear();
		})();
		shutdownPromise = closing;
		return closing;
	};
	const tryAcquireSessionWork: SessionHostManager["tryAcquireSessionWork"] =
		() => {
			if (shuttingDown) {
				return {
					kind: "rejected",
					reason: "The Session Host manager is shutting down.",
				};
			}
			if (reloadInProgress) {
				return {
					kind: "rejected",
					reason: "Cannot start Session work while resources are reloading.",
				};
			}
			sessionWorkAdmissionsInProgress += 1;
			let released = false;
			return Object.freeze({
				kind: "admitted" as const,
				release: () => {
					if (released) {
						return;
					}
					released = true;
					sessionWorkAdmissionsInProgress -= 1;
				},
			});
		};
	const assertNoPendingAdmissions = (): void => {
		if (shuttingDown) {
			throw new Error("The Session Host manager is shutting down.");
		}
		if (openRequestsInProgress > 0) {
			throw new Error("Cannot reload resources while a Session is opening.");
		}
		if (sessionWorkAdmissionsInProgress > 0) {
			throw new Error(
				"Cannot reload resources while Session work is being admitted."
			);
		}
	};
	const assertIdleForReload: SessionHostManager["assertIdleForReload"] =
		async () => {
			assertNoPendingAdmissions();
			for (const entry of entries.values()) {
				const host = entry.host;
				if (!entry.openingComplete || host === undefined) {
					throw new Error(
						"Cannot reload resources while a Session is opening."
					);
				}
				if (entry.closing !== undefined || entry.unloadCheck !== undefined) {
					throw new Error(
						"Cannot reload resources while a Session is closing."
					);
				}
				const snapshot = host.getSnapshot();
				if (snapshot.error !== null) {
					throw new Error(
						"Cannot reload resources while a Session has an unresolved error."
					);
				}
				if (
					snapshot.turnActive ||
					snapshot.isCompacting ||
					snapshot.executions.length > 0 ||
					snapshot.queuedSubmissions.length > 0 ||
					snapshot.steeringMessages.length > 0 ||
					entry.pluginRuntime?.hasBackgroundWork(entry.sessionId) === true
				) {
					throw new Error(
						"Cannot reload resources while Session work is running. Wait for active turns and Plugin tasks to finish, then try again."
					);
				}
			}
		};
	const replacePluginRuntime: SessionHostManager["replacePluginRuntime"] =
		async (runtime) => {
			if (!reloadInProgress) {
				throw new Error(
					"Plugin runtime replacement requires a resource reload."
				);
			}
			await assertIdleForReload();
			const openEntries = [...entries.values()];
			const started: ManagedHostEntry[] = [];
			try {
				for (const entry of openEntries) {
					started.push(entry);
					await runtime.startSession(entry.pluginSessionContext);
				}
			} catch (error) {
				await Promise.allSettled(
					started.map((entry) =>
						runtime.stopSession(entry.pluginSessionContext)
					)
				);
				throw error;
			}
			for (const entry of openEntries) {
				entry.unsubscribeBackgroundWork?.();
				entry.pluginRuntime = runtime;
				entry.unsubscribeBackgroundWork = runtime.onBackgroundWorkChange(
					entry.sessionId,
					() => {
						void maybeUnload(entry);
					}
				);
			}
			currentPluginRuntime = runtime;
		};
	const withIdleForReload: SessionHostManager["withIdleForReload"] = async (
		action
	) => {
		if (shuttingDown) {
			throw new Error("The Session Host manager is shutting down.");
		}
		if (reloadInProgress) {
			throw new Error("A resource reload is already in progress.");
		}
		reloadInProgress = true;
		try {
			await assertIdleForReload();
			return await action();
		} finally {
			reloadInProgress = false;
			for (const entry of entries.values()) {
				if (entry.views === 0) {
					void maybeUnload(entry);
				}
			}
		}
	};

	return {
		assertIdleForReload,
		tryAcquireSessionWork,
		withIdleForReload,
		replacePluginRuntime,
		onEvent: (listener) => {
			eventListeners.add(listener);
			return () => eventListeners.delete(listener);
		},
		openHost,
		releaseView,
		shutdownAll,
	};
};

export const getInteractiveSessionHostManager = (
	pluginRuntime?: PluginRuntime
): SessionHostManager => {
	interactiveManager ??= createSessionHostManager(pluginRuntime);
	return interactiveManager;
};

export const resetInteractiveSessionHostManager = async (): Promise<void> => {
	await interactiveManager?.shutdownAll();
	interactiveManager = undefined;
};

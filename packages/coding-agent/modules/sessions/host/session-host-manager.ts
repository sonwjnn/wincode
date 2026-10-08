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
		if (shuttingDown || !entry.openingComplete) {
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
			pluginRuntime: capabilities.getPluginRuntime?.() ?? processPluginRuntime,
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
		const entry = await getOpenEntry(
			capabilities,
			sessionId,
			executionMode,
			view,
			autoContinue
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

	return {
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

import type { PluginSessionContext } from "@/modules/plugins/public";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import { resolveProviderModelSelectionForHost } from "@/modules/providers/provider-model-selection";
import type { PluginSessionStatePersistence } from "@/modules/sessions/session-plugin-state";
import { SessionWriteOutcomeError } from "@/modules/sessions/storage/session-jsonl-store";
import type { SessionId } from "@/shared/identifiers";
import { nextChatSelection, restoreSelection } from "../selection";
import { projectSessionMessageRecords } from "../transcript-projection";
import { assertImportedSessionAgentIsAvailable } from "./imported-session-agent";
import { createSessionHost } from "./session-host";
import type {
	HostManagerSelectionCapabilities,
	PreparedSessionProviderComposition,
	SessionCapabilities,
	SessionHost,
	SessionHostManager,
	SessionHostManagerEvent,
	SessionHostOptions,
	SessionLifecycleContext,
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
	pluginSessionStatePersistence: PluginSessionStatePersistence;
	pendingPluginSessionStateError: Error | undefined;
	unloadCheck: Promise<void> | undefined;
};

export class SessionHostBusyError extends Error {
	readonly code = "session_busy" as const;
	readonly sessionId: SessionId;

	constructor(sessionId: SessionId, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionHostBusyError";
		this.sessionId = sessionId;
	}
}

export class SessionForkBusyError extends SessionHostBusyError {
	readonly sourceSessionId: SessionId;

	constructor(sourceSessionId: SessionId, message: string, cause?: unknown) {
		super(sourceSessionId, message, cause);
		this.name = "SessionForkBusyError";
		this.sourceSessionId = sourceSessionId;
	}
}

let interactiveManager: SessionHostManager | undefined;

export const createSessionHostManager = (
	processPluginRuntime?: PluginRuntime
): SessionHostManager => {
	const entries = new Map<SessionId, ManagedHostEntry>();
	const exclusiveSessionOperations = new Set<SessionId>();
	const lifecycleSessionsInProgress = new Set<SessionId>();
	const sessionLifecycleOperations = new Set<SessionId>();
	const activeExclusiveCompletions = new Set<Promise<void>>();
	const openRequestsBySession = new Map<SessionId, number>();
	const sessionWorkAdmissionsBySession = new Map<SessionId, number>();
	let currentPluginRuntime = processPluginRuntime;
	const eventListeners = new Set<(event: SessionHostManagerEvent) => void>();
	let shuttingDown = false;
	let reloadInProgress = false;
	let lifecycleInProgress = false;
	let openRequestsInProgress = 0;
	let sessionWorkAdmissionsInProgress = 0;
	let shutdownPromise: Promise<void> | undefined;
	const changeSessionCount = (
		counts: Map<SessionId, number>,
		sessionId: SessionId,
		delta: 1 | -1
	): void => {
		const next = (counts.get(sessionId) ?? 0) + delta;
		if (next === 0) {
			counts.delete(sessionId);
		} else {
			counts.set(sessionId, next);
		}
	};
	const emit = (event: SessionHostManagerEvent): void => {
		for (const listener of [...eventListeners]) {
			try {
				listener(event);
			} catch {
				// One consumer cannot interrupt another session's runtime.
			}
		}
	};
	const canUnload = (
		entry: ManagedHostEntry,
		host: SessionHost,
		{
			allowPassiveSteeringMessages = false,
		}: Readonly<{ allowPassiveSteeringMessages?: boolean }> = {}
	): boolean => {
		if (entry.pluginRuntime?.hasBackgroundWork(entry.sessionId) === true) {
			return false;
		}
		const snapshot = host.agentSession.getSnapshot();
		if (
			snapshot.turnActive ||
			snapshot.isCompacting ||
			snapshot.steeringMessages.some(({ status }) => status === "processing")
		) {
			return false;
		}
		if (!snapshot.projectionBlocked && snapshot.error !== null) {
			return false;
		}
		return !(
			snapshot.executions.length > 0 ||
			snapshot.queuedSubmissions.length > 0 ||
			(!(allowPassiveSteeringMessages || snapshot.projectionBlocked) &&
				snapshot.steeringMessages.length > 0)
		);
	};
	const maybeUnload = async (entry: ManagedHostEntry): Promise<void> => {
		if (
			shuttingDown ||
			reloadInProgress ||
			lifecycleInProgress ||
			sessionLifecycleOperations.has(entry.sessionId) ||
			lifecycleSessionsInProgress.has(entry.sessionId) ||
			exclusiveSessionOperations.has(entry.sessionId) ||
			!entry.openingComplete
		) {
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
				lifecycleSessionsInProgress.has(entry.sessionId) ||
				exclusiveSessionOperations.has(entry.sessionId) ||
				entry.host !== host ||
				entry.closing !== undefined ||
				sessionLifecycleOperations.has(entry.sessionId) ||
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
		providerModel: SessionHostOptions["providerModel"],
		providerCollection: SessionHostOptions["providerCollection"],
		autoContinue: boolean
	): ManagedHostEntry => {
		const opened = Promise.withResolvers<SessionHost>();
		const sessionSdk = capabilities.getSessionSdk?.();
		const store = capabilities.getStore();
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
			pendingPluginSessionStateError: undefined,
			pluginSessionStatePersistence: {
				read: (pluginId, key) =>
					store.getPluginSessionState(sessionId, pluginId, key),
				mutate: (pluginId, mutation) =>
					store.mutatePluginSessionState(sessionId, pluginId, mutation),
				reportWriteOutcome: (outcome) => {
					if (
						outcome.kind !== "indeterminate" &&
						!(outcome.kind === "committed" && outcome.projection === "blocked")
					) {
						return;
					}
					const error = new SessionWriteOutcomeError(outcome);
					if (entry.host === undefined) {
						entry.pendingPluginSessionStateError ??= error;
					} else {
						entry.host.reportStorageError(error);
					}
					return error;
				},
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
				?.startSession(
					entry.pluginSessionContext,
					entry.pluginSessionStatePersistence
				)
				.catch(() => undefined) ?? Promise.resolve();
		void sessionStart
			.then(() =>
				createSessionHost({
					autoContinue:
						autoContinue && entry.pendingPluginSessionStateError === undefined,
					capabilities,
					...(executionMode === undefined ? {} : { executionMode }),
					...(providerModel === undefined ? {} : { providerModel }),
					...(providerCollection === undefined ? {} : { providerCollection }),
					sessionId,
				} satisfies SessionHostOptions)
			)
			.then(
				(host) => {
					entry.host = host;
					if (entry.pendingPluginSessionStateError !== undefined) {
						host.reportStorageError(entry.pendingPluginSessionStateError);
						entry.pendingPluginSessionStateError = undefined;
					}
					entry.unsubscribeEvents = host.onEvent((event) =>
						emit({ event, sessionId, type: "session-event" })
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
		providerModel: SessionHostOptions["providerModel"],
		providerCollection: SessionHostOptions["providerCollection"],
		view: boolean,
		autoContinue: boolean
	): Promise<ManagedHostEntry> => {
		const entry = createEntry(
			capabilities,
			sessionId,
			executionMode,
			providerModel,
			providerCollection,
			autoContinue
		);
		if (view) {
			entry.views += 1;
		}
		await awaitEntryOpening(entry, view);
		return entry;
	};
	const continuePendingSteering = async (
		entry: ManagedHostEntry
	): Promise<void> => {
		const host = entry.host;
		if (
			host !== undefined &&
			!host.isImportedSessionActivationPending() &&
			host.getSnapshot().steeringMessages[0]?.status === "pending"
		) {
			await host.agentSession.continue();
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
			await continuePendingSteering(entry);
		}
		return entry;
	};
	const assertProviderModelSelectionBeforeHost = async (
		capabilities: HostManagerSelectionCapabilities,
		sessionId: SessionId,
		providerModel: SessionHostOptions["providerModel"],
		agentPinSelection: SessionHostOptions["providerModel"]
	): Promise<void> => {
		const store = capabilities.getStore();
		const [session, records] = await Promise.all([
			store.getSession(sessionId),
			store.listSessionRecords(sessionId),
		]);
		const messages = records.flatMap((record) =>
			projectSessionMessageRecords(record.messages, record)
		);
		// The Session's recorded tiers, and the newest message's own choice when
		// an Agent pin has to be validated against every identity it may restore.
		const latestSelection = nextChatSelection({ messages });
		const restored = restoreSelection({ messages, row: session });
		const lastMessageModel = latestSelection?.model;
		const isImportedSession =
			(await store.isSessionImported?.(sessionId)) ??
			(await store.isSessionImportActivationPending?.(sessionId)) ??
			false;
		assertImportedSessionAgentIsAvailable(
			capabilities.getRegistry(),
			latestSelection?.persistedAgent ?? records.at(-1)?.agentId,
			isImportedSession
		);
		const pluginRuntime =
			capabilities.getPluginRuntime?.() ?? currentPluginRuntime;
		const trustedRegistrations =
			pluginRuntime?.getProviderRegistrations() ?? [];
		if (agentPinSelection !== undefined) {
			for (const storedSelection of [session.model, lastMessageModel]) {
				if (storedSelection !== undefined) {
					resolveProviderModelSelectionForHost(
						storedSelection,
						trustedRegistrations
					);
				}
			}
		}
		const selection = providerModel ?? agentPinSelection ?? restored?.model;
		resolveProviderModelSelectionForHost(selection, trustedRegistrations);
	};
	const getOpenEntry = async (
		capabilities: SessionCapabilities,
		sessionId: SessionId,
		executionMode: SessionHostOptions["executionMode"],
		providerModel: SessionHostOptions["providerModel"],
		providerCollection: SessionHostOptions["providerCollection"],
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
					providerModel,
					providerCollection,
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
	const assertSessionOpenAdmission = (sessionId: SessionId): void => {
		if (shuttingDown) {
			throw new Error("The Session Host manager is shutting down.");
		}
		if (
			lifecycleInProgress ||
			lifecycleSessionsInProgress.has(sessionId) ||
			sessionLifecycleOperations.has(sessionId)
		) {
			throw new Error("A Session lifecycle operation is in progress.");
		}
		if (reloadInProgress) {
			throw new Error("Cannot open a Session while resources are reloading.");
		}
		if (exclusiveSessionOperations.has(sessionId)) {
			throw new SessionHostBusyError(
				sessionId,
				"Cannot open a Session while an exclusive Session operation is in progress."
			);
		}
	};
	const openHost: SessionHostManager["openHost"] = async ({
		autoContinue = true,
		capabilities,
		executionMode,
		providerModel,
		providerCollection,
		agentPinSelection,
		sessionId,
		view = false,
	}) => {
		let providerCollectionTransferred = false;
		let openRequestStarted = false;
		try {
			assertSessionOpenAdmission(sessionId);
			openRequestsInProgress += 1;
			changeSessionCount(openRequestsBySession, sessionId, 1);
			openRequestStarted = true;
			if (
				entries.get(sessionId) === undefined ||
				providerModel !== undefined ||
				agentPinSelection !== undefined
			) {
				await assertProviderModelSelectionBeforeHost(
					capabilities,
					sessionId,
					providerModel,
					agentPinSelection
				);
			}
			if (providerCollection !== undefined && entries.has(sessionId)) {
				throw new Error(
					"A prevalidated ProviderCollection cannot be attached to an existing Session Host."
				);
			}
			providerCollectionTransferred = providerCollection !== undefined;
			const entry = await getOpenEntry(
				capabilities,
				sessionId,
				executionMode,
				providerModel ?? agentPinSelection,
				providerCollection,
				view,
				autoContinue
			);
			return entry.opening;
		} finally {
			if (openRequestStarted) {
				openRequestsInProgress -= 1;
				changeSessionCount(openRequestsBySession, sessionId, -1);
			}
			if (!providerCollectionTransferred) {
				await providerCollection?.close().catch(() => undefined);
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
	const shutdownAll: SessionHostManager["shutdownAll"] = () => {
		if (shutdownPromise !== undefined) {
			return shutdownPromise;
		}
		shuttingDown = true;
		const closing = (async () => {
			await Promise.allSettled([...activeExclusiveCompletions]);
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
	const tryAcquireSessionWork: SessionHostManager["tryAcquireSessionWork"] = (
		sessionId
	) => {
		if (shuttingDown) {
			return {
				kind: "rejected",
				reason: "The Session Host manager is shutting down.",
			};
		}
		if (
			lifecycleInProgress ||
			(sessionId === undefined
				? lifecycleSessionsInProgress.size > 0
				: lifecycleSessionsInProgress.has(sessionId))
		) {
			return {
				kind: "rejected",
				reason: "Cannot start Session work during a lifecycle operation.",
			};
		}
		if (sessionId !== undefined && sessionLifecycleOperations.has(sessionId)) {
			return {
				kind: "rejected",
				reason: "Cannot start Session work during a lifecycle operation.",
			};
		}
		if (reloadInProgress) {
			return {
				kind: "rejected",
				reason: "Cannot start Session work while resources are reloading.",
			};
		}
		if (sessionId !== undefined && exclusiveSessionOperations.has(sessionId)) {
			return {
				kind: "rejected",
				reason:
					"Cannot start Session work during an exclusive Session operation.",
			};
		}
		sessionWorkAdmissionsInProgress += 1;
		if (sessionId !== undefined) {
			changeSessionCount(sessionWorkAdmissionsBySession, sessionId, 1);
		}
		let released = false;
		return Object.freeze({
			kind: "admitted" as const,
			release: () => {
				if (released) {
					return;
				}
				released = true;
				sessionWorkAdmissionsInProgress -= 1;
				if (sessionId !== undefined) {
					changeSessionCount(sessionWorkAdmissionsBySession, sessionId, -1);
				}
			},
		});
	};
	const assertNoPendingAdmissions = (): void => {
		if (shuttingDown) {
			throw new Error("The Session Host manager is shutting down.");
		}
		if (lifecycleInProgress || lifecycleSessionsInProgress.size > 0) {
			throw new Error(
				"Cannot reload resources during a Session lifecycle operation."
			);
		}
		if (sessionLifecycleOperations.size > 0) {
			throw new Error(
				"Cannot start another lifecycle operation while a Session export is in progress."
			);
		}
		if (openRequestsInProgress > 0) {
			throw new Error("Cannot reload resources while a Session is opening.");
		}
		if (sessionWorkAdmissionsInProgress > 0) {
			throw new Error(
				"Cannot reload resources while Session work is being admitted."
			);
		}
		if (activeExclusiveCompletions.size > 0) {
			throw new Error(
				"Cannot reload resources while an exclusive Session operation is in progress."
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
	const updateEntryPluginRuntime = (
		openEntries: readonly ManagedHostEntry[],
		runtime: PluginRuntime
	): void => {
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
	const commitProviderCompositionWithoutPlugins = async (
		openEntries: readonly ManagedHostEntry[],
		runtime: PluginRuntime
	): Promise<void> => {
		const safeCompositions: PreparedSessionProviderComposition[] = [];
		try {
			for (const entry of openEntries) {
				if (entry.host?.prepareProviderComposition === undefined) {
					continue;
				}
				safeCompositions.push(
					await entry.host.prepareProviderComposition(runtime, {
						includePluginProviders: false,
					})
				);
			}
			await Promise.all(
				safeCompositions.map((composition) => composition.commit())
			);
		} catch {
			await Promise.allSettled(
				safeCompositions.map((composition) => composition.discard())
			);
			await Promise.allSettled(
				openEntries.flatMap((entry) =>
					entry.host?.failProviderCompositionClosed === undefined
						? []
						: [entry.host.failProviderCompositionClosed()]
				)
			);
		}
	};
	const startReplacementPluginSessions = async (
		runtime: PluginRuntime,
		openEntries: readonly ManagedHostEntry[],
		trustChanged: boolean
	): Promise<boolean> => {
		const started: ManagedHostEntry[] = [];
		try {
			for (const entry of openEntries) {
				started.push(entry);
				await runtime.startSession(
					entry.pluginSessionContext,
					entry.pluginSessionStatePersistence
				);
			}
			return true;
		} catch (error) {
			await Promise.allSettled(
				started.map((entry) => runtime.stopSession(entry.pluginSessionContext))
			);
			if (!trustChanged) {
				throw error;
			}
			await commitProviderCompositionWithoutPlugins(openEntries, runtime);
			updateEntryPluginRuntime(openEntries, runtime);
			return false;
		}
	};
	const replacePluginRuntime: SessionHostManager["replacePluginRuntime"] =
		async (runtime, { trustChanged = false } = {}) => {
			if (!reloadInProgress) {
				throw new Error(
					"Plugin runtime replacement requires a resource reload."
				);
			}
			await assertIdleForReload();
			const openEntries = [...entries.values()];
			if (
				!(await startReplacementPluginSessions(
					runtime,
					openEntries,
					trustChanged
				))
			) {
				return;
			}

			if (!trustChanged && runtime === currentPluginRuntime) {
				updateEntryPluginRuntime(openEntries, runtime);
				return;
			}

			const prepared: PreparedSessionProviderComposition[] = [];
			try {
				for (const entry of openEntries) {
					if (entry.host?.prepareProviderComposition === undefined) {
						continue;
					}
					prepared.push(await entry.host.prepareProviderComposition(runtime));
				}
			} catch (error) {
				await Promise.allSettled(
					prepared.map((composition) => composition.discard())
				);
				if (!trustChanged) {
					await Promise.allSettled(
						openEntries.map((entry) =>
							runtime.stopSession(entry.pluginSessionContext)
						)
					);
					throw error;
				}
				await commitProviderCompositionWithoutPlugins(openEntries, runtime);
				updateEntryPluginRuntime(openEntries, runtime);
				return;
			}

			await Promise.all(prepared.map((composition) => composition.commit()));
			updateEntryPluginRuntime(openEntries, runtime);
		};
	const closeEntryForLifecycle = async (
		entry: ManagedHostEntry
	): Promise<void> => {
		const host = entry.host;
		if (host === undefined) {
			throw new Error(
				"Cannot start a lifecycle operation while a Session is opening."
			);
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
	};
	const assertExportLifecycleAdmission = (sessionId: SessionId): void => {
		if (reloadInProgress) {
			throw new Error("Cannot export a Session while resources are reloading.");
		}
		if (shuttingDown || lifecycleInProgress) {
			throw new Error("Cannot export a Session during a lifecycle operation.");
		}
		if (
			sessionLifecycleOperations.has(sessionId) ||
			lifecycleSessionsInProgress.has(sessionId) ||
			exclusiveSessionOperations.has(sessionId)
		) {
			throw new Error(
				"Cannot export a Session while another lifecycle operation is in progress."
			);
		}
		if ((openRequestsBySession.get(sessionId) ?? 0) > 0) {
			throw new Error("Cannot export a Session while it is opening.");
		}
		if ((sessionWorkAdmissionsBySession.get(sessionId) ?? 0) > 0) {
			throw new Error(
				"Cannot export a Session while its work is being admitted."
			);
		}
	};
	const assertSessionLifecycleAdmission = (
		operation: "delete" | "reset",
		sessionId: SessionId
	): void => {
		if (shuttingDown || lifecycleInProgress) {
			throw new Error(
				`Cannot ${operation} during a Session lifecycle operation.`
			);
		}
		if (
			lifecycleSessionsInProgress.has(sessionId) ||
			sessionLifecycleOperations.has(sessionId)
		) {
			throw new Error(
				`Cannot ${operation} while this Session is in a lifecycle operation.`
			);
		}
		if (exclusiveSessionOperations.has(sessionId)) {
			throw new Error(
				`Cannot ${operation} while an exclusive Session operation is in progress.`
			);
		}
		if ((openRequestsBySession.get(sessionId) ?? 0) > 0) {
			throw new Error(`Cannot ${operation} while this Session is opening.`);
		}
		if ((sessionWorkAdmissionsBySession.get(sessionId) ?? 0) > 0) {
			throw new Error(
				`Cannot ${operation} while this Session has work being admitted.`
			);
		}
	};
	const assertLifecycleAdmission = (
		operation: "delete" | "export" | "reset",
		sessionId?: SessionId
	): void => {
		if (operation === "export") {
			if (sessionId === undefined) {
				throw new Error("Cannot export a Session without its Session ID.");
			}
			assertExportLifecycleAdmission(sessionId);
			return;
		}
		if (reloadInProgress) {
			throw new Error(
				`Cannot ${operation === "reset" ? "reset Session data" : "delete a Session"} while resources are reloading.`
			);
		}
		if (sessionId === undefined) {
			assertNoPendingAdmissions();
			return;
		}
		assertSessionLifecycleAdmission(operation, sessionId);
	};
	const assertExclusiveAdmission = (
		sessionId: SessionId,
		operation: "fork" | "context edit"
	): void => {
		const busy = (message: string, cause?: unknown): never => {
			throw operation === "fork"
				? new SessionForkBusyError(sessionId, message, cause)
				: new SessionHostBusyError(sessionId, message, cause);
		};
		const action =
			operation === "fork" ? "fork a Session" : "edit Session Context";
		if (shuttingDown) {
			busy("The Session Host manager is shutting down.");
		}
		if (
			lifecycleInProgress ||
			lifecycleSessionsInProgress.has(sessionId) ||
			sessionLifecycleOperations.has(sessionId)
		) {
			busy(`Cannot ${action} during a lifecycle operation.`);
		}
		if (reloadInProgress) {
			busy(`Cannot ${action} while resources are reloading.`);
		}
		if (exclusiveSessionOperations.has(sessionId)) {
			busy(
				"Another exclusive operation is already in progress for this Session."
			);
		}
		if ((openRequestsBySession.get(sessionId) ?? 0) > 0) {
			busy(`Cannot ${action} while its Host is opening.`);
		}
		if ((sessionWorkAdmissionsBySession.get(sessionId) ?? 0) > 0) {
			busy(`Cannot ${action} while Session work is being admitted.`);
		}
	};
	const assertEntryIdleForLifecycle = (
		entry: ManagedHostEntry,
		operation: "delete" | "export" | "reset"
	): void => {
		const host = entry.host;
		if (!entry.openingComplete || host === undefined) {
			throw new Error(
				"Cannot start a lifecycle operation while a Session is opening."
			);
		}
		if (entry.closing !== undefined || entry.unloadCheck !== undefined) {
			throw new Error(
				"Cannot start a lifecycle operation while a Session is closing."
			);
		}
		if (!canUnload(entry, host)) {
			throw new Error(
				operation === "reset"
					? "Cannot reset Session data while a Host has active or pending work."
					: `Cannot ${operation} a Session while its Host has active or pending work.`
			);
		}
	};
	const assertEntryIdleForFork = (entry: ManagedHostEntry): void => {
		const busy = (message: string): never => {
			throw new SessionForkBusyError(entry.sessionId, message);
		};
		const host = entry.host;
		if (!entry.openingComplete || host === undefined) {
			throw new SessionForkBusyError(
				entry.sessionId,
				"Cannot start a fork while the Session Host is opening."
			);
		}
		if (entry.closing !== undefined || entry.unloadCheck !== undefined) {
			busy("Cannot fork a Session while its Host is closing.");
		}
		const snapshot = host.getSnapshot();
		if (snapshot.projectionBlocked) {
			busy("Cannot fork a Session with unresolved storage state.");
		}
		if (!canUnload(entry, host, { allowPassiveSteeringMessages: true })) {
			busy("Cannot fork a Session while its Host has active or pending work.");
		}
	};
	const assertEntryIdleForContextEdit = (entry: ManagedHostEntry): void => {
		const busy = (message: string): never => {
			throw new SessionHostBusyError(entry.sessionId, message);
		};
		const host = entry.host;
		if (!entry.openingComplete || host === undefined) {
			throw new SessionHostBusyError(
				entry.sessionId,
				"Cannot edit Session Context while the Host is opening."
			);
		}
		if (entry.closing !== undefined || entry.unloadCheck !== undefined) {
			busy("Cannot edit Session Context while the Host is closing.");
		}
		if (host.getSnapshot().projectionBlocked) {
			busy("Cannot edit Session Context with unresolved storage state.");
		}
		if (!canUnload(entry, host)) {
			busy(
				"Cannot edit Session Context while the Host has active or pending work."
			);
		}
	};
	const runLifecycleAction = async <Result>(
		openEntries: readonly ManagedHostEntry[],
		action: (context: SessionLifecycleContext) => Promise<Result>,
		sessionId?: SessionId
	): Promise<Result> => {
		if (sessionId === undefined) {
			lifecycleInProgress = true;
		} else {
			lifecycleSessionsInProgress.add(sessionId);
		}
		try {
			for (const entry of openEntries) {
				await closeEntryForLifecycle(entry);
			}
			return await action({ existingHostWriter: false });
		} finally {
			if (sessionId === undefined) {
				lifecycleInProgress = false;
			} else {
				lifecycleSessionsInProgress.delete(sessionId);
			}
			for (const entry of entries.values()) {
				if (entry.views === 0) {
					void maybeUnload(entry);
				}
			}
		}
	};
	const withIdleForSessionLifecycle: SessionHostManager["withIdleForSessionLifecycle"] =
		async (sessionId, action, operation = "delete") => {
			assertLifecycleAdmission(operation, sessionId);
			const entry = entries.get(sessionId);
			if (entry !== undefined) {
				assertEntryIdleForLifecycle(entry, operation);
			}
			if (operation === "export") {
				sessionLifecycleOperations.add(sessionId);
				try {
					return await action({ existingHostWriter: entry !== undefined });
				} finally {
					sessionLifecycleOperations.delete(sessionId);
					const current = entries.get(sessionId);
					if (current?.views === 0) {
						void maybeUnload(current);
					}
				}
			}
			return runLifecycleAction(
				entry === undefined ? [] : [entry],
				action,
				sessionId
			);
		};
	const runExclusiveSessionAction = async <Result>(
		sessionId: SessionId,
		entry: ManagedHostEntry | undefined,
		action: (host: SessionHost | undefined) => Promise<Result>
	): Promise<Result> => {
		const completed = Promise.withResolvers<void>();
		exclusiveSessionOperations.add(sessionId);
		activeExclusiveCompletions.add(completed.promise);
		try {
			return await action(entry?.host);
		} finally {
			exclusiveSessionOperations.delete(sessionId);
			activeExclusiveCompletions.delete(completed.promise);
			completed.resolve();
			if (entry?.views === 0) {
				void maybeUnload(entry);
			}
		}
	};
	const withIdleForSessionFork: SessionHostManager["withIdleForSessionFork"] =
		async (sessionId, action) => {
			assertExclusiveAdmission(sessionId, "fork");
			const entry = entries.get(sessionId);
			if (entry !== undefined) {
				assertEntryIdleForFork(entry);
			}
			return runExclusiveSessionAction(sessionId, entry, action);
		};
	const withIdleForSessionContextEdit: SessionHostManager["withIdleForSessionContextEdit"] =
		async (sessionId, action) => {
			assertExclusiveAdmission(sessionId, "context edit");
			const entry = entries.get(sessionId);
			if (entry !== undefined) {
				assertEntryIdleForContextEdit(entry);
			}
			return runExclusiveSessionAction(sessionId, entry, action);
		};
	const withIdleForSessionDataReset: SessionHostManager["withIdleForSessionDataReset"] =
		async (action) => {
			assertLifecycleAdmission("reset");
			const openEntries = [...entries.values()].sort((left, right) =>
				left.sessionId.localeCompare(right.sessionId)
			);
			for (const entry of openEntries) {
				assertEntryIdleForLifecycle(entry, "reset");
			}
			return runLifecycleAction(openEntries, action);
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
		if (lifecycleInProgress) {
			throw new Error("A Session lifecycle operation is in progress.");
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
		withIdleForSessionLifecycle,
		withIdleForSessionFork,
		withIdleForSessionContextEdit,
		withIdleForSessionDataReset,
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

export const withSessionManagerWork = async <Result>(
	manager: Pick<SessionHostManager, "tryAcquireSessionWork">,
	action: () => Promise<Result>,
	sessionId?: SessionId
): Promise<Result> => {
	const admission = manager.tryAcquireSessionWork(sessionId);
	if (admission.kind === "rejected") {
		throw new Error(admission.reason);
	}
	try {
		return await action();
	} finally {
		admission.release();
	}
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

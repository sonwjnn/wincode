import type { AgentId, AgentTurnEvent } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { isNull, omitUndefined } from "@wincode/runtime-utils";
import { resolveActiveAgentId } from "@/modules/agents/registry";
import { rebuildActiveMessages } from "../compaction/compaction";
import type { SessionCompaction } from "../compaction/types";
import { AgentSessionImpl } from "../engine/agent-session";
import type {
	AgentSession,
	AgentSessionInternalPort,
	AgentSessionPorts,
} from "../engine/types";
import {
	type SessionMessage,
	sanitizeInterruptedSessionMessages,
} from "../message";
import { resolveSessionSelection } from "../selection";
import {
	SESSION_LEASE_RENEWAL_INTERVAL_MS,
	type SessionLease,
	SessionLeaseLostError,
} from "../storage/session-lease";
import {
	isDelegatedSessionMessageId,
	projectSessionRecords,
} from "../storage/session-record";
import { createSessionPorts } from "./session-ports";
import type {
	SessionCapabilities,
	SessionHost,
	SessionHostFailure,
	SessionHostOptions,
} from "./types";

/**
 * The durable Session projection used to initialize the Agent Session, plus
 * the session-row facts Session Selection resolves against. This is where
 * durable records become a Session Transcript and Session Context.
 */
type OpenedSession = Readonly<{
	compactions: SessionCompaction[];
	context: SessionMessage[];
	model: ChatModelSelection | undefined;
	transcript: SessionMessage[];
	variant: ModelVariant | undefined;
}>;
const closingHosts = new Map<SessionHostOptions["sessionId"], Promise<void>>();

const waitForClosingHost = async (
	sessionId: SessionHostOptions["sessionId"]
): Promise<void> => {
	const closing = closingHosts.get(sessionId);
	if (closing !== undefined) {
		await closing.catch(() => undefined);
	}
};

/**
 * Reads one session's durable state and projects it into the Agent Session's
 * initial state: the Session Transcript as the surface presents it, the
 * Session Context rebuilt around the latest compaction, and compaction history.
 *
 * The Context is derived from the un-annotated projection — display annotation
 * is the surface's, and never reaches what the model is sent — and delegated
 * Subagent rows are grouped out of it, so transcript presentation and model
 * context stay separate concerns.
 */
const openSession = async (
	capabilities: SessionCapabilities,
	sessionId: SessionHostOptions["sessionId"]
): Promise<OpenedSession> => {
	const store = capabilities.getStore();
	const [session, compactions, records] = await Promise.all([
		store.getSession(sessionId),
		store.getCompactions(sessionId),
		store.listSessionRecords(sessionId),
	]);
	const transcript = sanitizeInterruptedSessionMessages(
		projectSessionRecords(records)
	);
	const active = transcript.filter(
		(message) => !isDelegatedSessionMessageId(message.id)
	);
	return {
		compactions,
		context: rebuildActiveMessages(active, compactions.at(-1) ?? null),
		model: session.model,
		transcript,
		variant: session.variant,
	};
};

/**
 * Re-exposes Agent Turn Events the Agent Session receives: each event the
 * ports report is forwarded through its callbacks and to Host listeners, in
 * the order the turn produced them.
 */
const withEventChannel = (
	ports: AgentSessionPorts,
	publish: (event: AgentTurnEvent) => void
): AgentSessionPorts => ({
	...ports,
	turnRunner: {
		...ports.turnRunner,
		run: (request) =>
			ports.turnRunner.run({
				...request,
				callbacks: {
					...request.callbacks,
					onEvent: (event) => {
						request.callbacks.onEvent(event);
						publish(event);
					},
					onTerminal: (event) => {
						request.callbacks.onTerminal(event);
						publish(event);
					},
				},
			}),
	},
});

/**
 * Opens one session and owns the assembly's lifetime. Its factory is
 * asynchronous because opening is construction, not a Session Command: the
 * Transcript, Context, and compactions used to initialize the Agent Session
 * are projected here; creating the Agent Session itself stays synchronous.
 *
 * The consumer that constructs a Host owns calling `shutdown`. Capabilities are
 * read through the getters the caller supplied, so a long session keeps seeing
 * the connections, configuration, and catalogs it was built with.
 */
export const createSessionHost = async ({
	capabilities,
	lease: leaseOptions,
	sessionId,
}: SessionHostOptions): Promise<SessionHost> => {
	await waitForClosingHost(sessionId);
	const leaseClock = leaseOptions?.now ?? Date.now;
	const sessionLease: SessionLease = await capabilities
		.getStore()
		.acquireSessionLease(sessionId, { now: leaseClock });
	const eventListeners = new Set<(event: AgentTurnEvent) => void>();
	const fatalListeners = new Set<(failure: SessionHostFailure) => void>();
	let agentSession: AgentSession | undefined;
	let agentSessionInternalPort: AgentSessionInternalPort | undefined;
	let isShutDown = false;
	let isLeaseLost = false;
	let fatalFailure: SessionHostFailure | null = null;
	let stopLeaseRenewal: (() => void) | undefined;
	let shutdownPromise: Promise<void> | undefined;

	/**
	 * Reports one event to the Host's observers. Everything the Agent Session
	 * reads has already been reported through its own callbacks, so a listener
	 * that takes a Session Snapshot sees what the event did. A failing observer
	 * cannot change session state or stop the turn, as with the Agent Session's
	 * own emitter.
	 */
	const publish = (event: AgentTurnEvent): void => {
		if (isShutDown) {
			return;
		}
		for (const listener of [...eventListeners]) {
			try {
				listener(event);
			} catch {
				// The turn continues; only this observer loses the event.
			}
		}
	};
	const getAgentSessionInternalPort = (): AgentSessionInternalPort => {
		if (agentSessionInternalPort === undefined) {
			throw new Error("Agent Session is not ready.");
		}
		return agentSessionInternalPort;
	};
	const stopRenewal = (): void => {
		stopLeaseRenewal?.();
		stopLeaseRenewal = undefined;
	};
	const shutdown = (): Promise<void> => {
		if (shutdownPromise !== undefined) {
			return shutdownPromise;
		}
		isShutDown = true;
		const activeAgentSession = agentSession;
		const activeInternalPort = agentSessionInternalPort;
		let releaseImmediately = activeAgentSession === undefined;
		let agentSessionShutdown = Promise.resolve();
		if (activeAgentSession !== undefined) {
			const snapshot = activeAgentSession.getSnapshot();
			releaseImmediately =
				activeInternalPort === undefined ||
				!activeInternalPort.hasPendingWork();
			if (snapshot.isCompacting) {
				activeAgentSession.cancelCompaction();
			}
			// Cancel rather than interrupt: the turn must unwind through its
			// pipeline so its pending durable checkpoint holds the Session Lease.
			if (snapshot.turnActive) {
				activeAgentSession.cancel();
			}
			agentSessionShutdown =
				activeInternalPort?.shutdown() ?? Promise.resolve();
		}
		eventListeners.clear();
		fatalListeners.clear();
		if (releaseImmediately) {
			stopRenewal();
			sessionLease.release();
		}
		const closingShutdown = (async () => {
			try {
				await agentSessionShutdown;
			} finally {
				if (!releaseImmediately) {
					stopRenewal();
					sessionLease.release();
				}
			}
		})();
		shutdownPromise = closingShutdown;
		closingHosts.set(sessionId, closingShutdown);
		void closingShutdown.then(
			() => {
				if (closingHosts.get(sessionId) === closingShutdown) {
					closingHosts.delete(sessionId);
				}
			},
			() => {
				if (closingHosts.get(sessionId) === closingShutdown) {
					closingHosts.delete(sessionId);
				}
			}
		);
		return closingShutdown;
	};
	const observeLeaseLossShutdown = async (
		shutdownWork: Promise<void>
	): Promise<void> => {
		try {
			await shutdownWork;
		} catch {
			// Lease loss is already fatal; cleanup cannot restore ownership.
		}
	};
	const reportLeaseLoss = (): void => {
		if (isLeaseLost || isShutDown) {
			return;
		}
		isLeaseLost = true;
		fatalFailure = { code: "session_lease_lost" };
		const listeners = [...fatalListeners];
		stopRenewal();
		// Renewal callbacks are synchronous; start quiescence before notifying
		// observers, and observe cleanup failures without detaching a rejection.
		let shutdownWork: Promise<void>;
		try {
			shutdownWork = shutdown();
		} catch {
			shutdownWork = Promise.resolve();
		}
		void observeLeaseLossShutdown(shutdownWork);
		for (const listener of listeners) {
			try {
				listener(fatalFailure);
			} catch {
				// A failure observer cannot keep a lost Host alive.
			}
		}
	};
	const schedule =
		leaseOptions?.schedule ??
		((callback: () => void, intervalMs: number): (() => void) => {
			const timer = setInterval(callback, intervalMs);
			return () => clearInterval(timer);
		});

	try {
		const scheduledStop = schedule(() => {
			if (!sessionLease.renew()) {
				reportLeaseLoss();
			}
		}, SESSION_LEASE_RENEWAL_INTERVAL_MS);
		if (isShutDown) {
			scheduledStop();
		} else {
			stopLeaseRenewal = scheduledStop;
		}
		const opened = await openSession(capabilities, sessionId);
		if (isShutDown) {
			throw new SessionLeaseLostError();
		}
		const ports: AgentSessionPorts = withEventChannel(
			createSessionPorts({
				capabilities,
				agentSession: getAgentSessionInternalPort,
				isShutDown: () => isShutDown,
				onLeaseLost: reportLeaseLoss,
				renewLease: sessionLease.renew,
				sessionId,
			}),
			publish
		);
		const initialRegistry = capabilities.getRegistry();
		const initialSelection = resolveSessionSelection({
			messages: [...opened.transcript],
			sessionModel: opened.model,
			sessionVariant: opened.variant,
			...(isNull(initialRegistry)
				? {}
				: {
						resolveAgent: (agentId: AgentId | undefined) =>
							resolveActiveAgentId(initialRegistry, agentId),
					}),
		});
		const initialAgent = isNull(initialRegistry)
			? initialSelection?.agent
			: resolveActiveAgentId(initialRegistry, initialSelection?.agent);
		const openedAgentSession = new AgentSessionImpl({
			initialCompactions: opened.compactions,
			...omitUndefined({
				initialAgent,
				initialSessionModel: opened.model ?? initialSelection?.model,
				initialSessionVariant: opened.variant ?? initialSelection?.variant,
			}),
			initialContext: opened.context,
			initialTranscript: opened.transcript,
			ports,
			sessionId,
		});
		agentSessionInternalPort = openedAgentSession.internalPort;
		agentSession = openedAgentSession;
		if (isShutDown) {
			throw new SessionLeaseLostError();
		}

		return {
			agentSession: openedAgentSession,
			getSelection: () => {
				const registry = capabilities.getRegistry();
				return resolveSessionSelection({
					messages: [...opened.transcript],
					sessionModel: opened.model,
					sessionVariant: opened.variant,
					...(isNull(registry)
						? {}
						: {
								resolveAgent: (agentId: AgentId | undefined) =>
									resolveActiveAgentId(registry, agentId),
							}),
				});
			},
			getSnapshot: openedAgentSession.getSnapshot,
			onEvent: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			onFatal: (listener) => {
				if (fatalFailure !== null) {
					listener(fatalFailure);
					return () => false;
				}
				if (isShutDown) {
					return () => false;
				}
				fatalListeners.add(listener);
				return () => fatalListeners.delete(listener);
			},
			shutdown,
			subscribe: (listener) =>
				openedAgentSession.subscribe(() => {
					if (!isShutDown) {
						listener();
					}
				}),
		};
	} catch (error) {
		await shutdown();
		throw error;
	}
};

export type {
	SessionCapabilities,
	SessionHost,
	SessionHostFailure,
	SessionHostLeaseOptions,
	SessionHostOptions,
	SessionLeaseScheduler,
} from "./types";

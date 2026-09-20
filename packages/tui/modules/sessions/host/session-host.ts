import type { AgentId, AgentTurnEvent } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { isNull } from "@wincode/runtime-utils";
import { resolveActiveAgentId } from "@/modules/agents/registry";
import { rebuildActiveMessages } from "../compaction/compaction";
import type { SessionCompaction } from "../compaction/types";
import { createSessionEngine } from "../engine/session-engine";
import type { SessionEngine, SessionEnginePorts } from "../engine/types";
import {
	type SessionMessage,
	sanitizeInterruptedSessionMessages,
} from "../message";
import { resolveSessionSelection } from "../selection";
import {
	isDelegatedSessionMessageId,
	projectSessionRecords,
} from "../storage/session-record";
import { createSessionPorts } from "./session-ports";
import type {
	SessionCapabilities,
	SessionHost,
	SessionHostOptions,
} from "./types";

/**
 * What opening produced: the session the Engine is born with, plus the
 * session-row facts a Session Selection resolves against. It is the one place
 * durable records become a Session Transcript and a Session Context.
 */
type OpenedSession = Readonly<{
	compactions: SessionCompaction[];
	context: SessionMessage[];
	model: ChatModelSelection | undefined;
	transcript: SessionMessage[];
	variant: ModelVariant | undefined;
}>;

/**
 * Reads one session's durable state and projects it into the session the Engine
 * is born with: the Session Transcript as the surface presents it, the Session
 * Context rebuilt around the latest compaction, and that session's compaction
 * history.
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
 * Re-exposes the Agent Turn Events the Engine receives: every event the ports
 * report is forwarded to the Engine through its callbacks and observed by the
 * Host's listeners, in the order the turn produced them.
 */
const withEventChannel = (
	ports: SessionEnginePorts,
	publish: (event: AgentTurnEvent) => void
): SessionEnginePorts => ({
	...ports,
	runtime: {
		...ports.runtime,
		run: (request) =>
			ports.runtime.run({
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
 * Transcript, Context, and compactions a session is born with are read and
 * projected here, and the Engine itself stays synchronous.
 *
 * The consumer that constructs a Host owns calling `shutdown`. Capabilities are
 * read through the getters the caller supplied, so a long session keeps seeing
 * the connections, configuration, and catalogs it was built with.
 */
export const createSessionHost = async ({
	capabilities,
	sessionId,
}: SessionHostOptions): Promise<SessionHost> => {
	const opened = await openSession(capabilities, sessionId);
	const eventListeners = new Set<(event: AgentTurnEvent) => void>();
	let isShutDown = false;
	/**
	 * Reports one event to the Host's observers. Everything the Engine reads
	 * has already been reported through its own callbacks, so a listener that
	 * takes a Session Snapshot sees what the event did. A failing observer
	 * cannot change session state or stop the turn, as with the Engine's own
	 * emitter.
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
	let engine: SessionEngine;
	const ports: SessionEnginePorts = withEventChannel(
		createSessionPorts({
			capabilities,
			engine: () => engine,
			sessionId,
		}),
		publish
	);
	engine = createSessionEngine({
		initialCompactions: opened.compactions,
		initialContext: opened.context,
		initialTranscript: opened.transcript,
		ports,
		sessionId,
	});

	return {
		engine,
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
		getSnapshot: engine.getSnapshot,
		onEvent: (listener) => {
			eventListeners.add(listener);
			return () => eventListeners.delete(listener);
		},
		shutdown: () => {
			// The session ends first, so an observer still sees the approvals
			// and waiting messages shutdown settles; nothing reaches either
			// channel afterwards, when its consumer is tearing down.
			engine.shutdown();
			isShutDown = true;
			eventListeners.clear();
		},
		subscribe: (listener) =>
			engine.subscribe(() => {
				if (!isShutDown) {
					listener();
				}
			}),
	};
};

export type {
	SessionCapabilities,
	SessionHost,
	SessionHostOptions,
} from "./types";

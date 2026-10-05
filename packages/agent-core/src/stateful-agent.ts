import { AgentInvariantError } from "./errors";
import type { AgentTurnEvent, AgentTurnTerminalEvent } from "./events";
import { agentTurnAssistantMessageId, toSessionMessageId } from "./identifiers";
import type {
	AgentRuntime,
	AgentRuntimeRunOptions,
	AgentTurnEventStream,
} from "./runtime";
import type {
	AgentTurn,
	AgentTurnId,
	AgentTurnMessage,
	AgentTurnPart,
} from "./turn";

const EMPTY_AGENT_TURN_MESSAGES: readonly AgentTurnMessage[] = [];

export type StatefulAgentSnapshot = Readonly<{
	activeTurnId: AgentTurnId | null;
	closed: boolean;
	context: readonly AgentTurnMessage[];
	lastTerminalEvent: AgentTurnTerminalEvent | null;
	turnCount: number;
}>;

export type StatefulAgent = Readonly<{
	abort: () => void;
	/** Queues prepared input for the next safe Model Step boundary. */
	steer: (message: AgentTurnMessage) => void;
	/** Queues prepared input for a safe follow-up boundary without starting or interrupting a turn. */
	followUp: (message: AgentTurnMessage) => void;
	getSnapshot: () => StatefulAgentSnapshot;
	run: AgentRuntime["run"];
	shutdown: () => Promise<void>;
	subscribe: (listener: () => void) => () => void;
	waitForIdle: () => Promise<void>;
}>;

export type StatefulAgentOptions = Readonly<{
	runtime: AgentRuntime;
}>;

type AgentTurnContextProjector = Readonly<{
	appendFollowUpMessages: (messages: readonly AgentTurnMessage[]) => void;
	appendSteeringMessages: (messages: readonly AgentTurnMessage[]) => void;
	observe: (event: AgentTurnEvent) => void;
}>;
type AgentTurnMessageSource = () =>
	| readonly AgentTurnMessage[]
	| Promise<readonly AgentTurnMessage[]>;

const takePreparedAgentTurnMessages = async ({
	append,
	context,
	queue,
	requested,
}: {
	append: (messages: readonly AgentTurnMessage[]) => void;
	context: readonly AgentTurnMessage[];
	queue: AgentTurnMessage[];
	requested: AgentTurnMessageSource | undefined;
}): Promise<readonly AgentTurnMessage[]> => {
	const requestedMessages = (await requested?.()) ?? EMPTY_AGENT_TURN_MESSAGES;
	const queuedMessages =
		queue.length === 0 ? EMPTY_AGENT_TURN_MESSAGES : queue.splice(0);
	if (queuedMessages.length === 0 && requestedMessages.length === 0) {
		return EMPTY_AGENT_TURN_MESSAGES;
	}
	let candidates: readonly AgentTurnMessage[] = queuedMessages;
	if (queuedMessages.length === 0) {
		candidates = requestedMessages;
	} else if (requestedMessages.length > 0) {
		candidates = [...queuedMessages, ...requestedMessages];
	}
	const messages = candidates.filter(
		(message) => !context.some((existing) => existing.id === message.id)
	);
	if (messages.length > 0) {
		append(messages);
	}
	return messages;
};

const createAgentTurnContextProjector = (
	turn: AgentTurn,
	getContext: () => readonly AgentTurnMessage[],
	setContext: (context: readonly AgentTurnMessage[]) => void
): AgentTurnContextProjector => {
	let assistantSegmentIndex = 0;
	let assistantParts: AgentTurnPart[] = [];
	let toolResults: AgentTurnMessage[] = [];
	const flushModelStep = (): void => {
		if (assistantParts.length === 0 && toolResults.length === 0) {
			return;
		}
		const messages = [...getContext()];
		if (assistantParts.length > 0) {
			const assistantId = agentTurnAssistantMessageId(
				turn.id,
				assistantSegmentIndex
			);
			const assistantIndex = messages.findIndex(
				(message) => message.id === assistantId
			);
			const existingAssistant = messages[assistantIndex];
			const assistantMessage: AgentTurnMessage = {
				id: assistantId,
				parts: [
					...(existingAssistant?.role === "assistant"
						? existingAssistant.parts
						: []),
					...assistantParts,
				],
				role: "assistant",
			};
			if (assistantIndex < 0) {
				messages.push(assistantMessage);
			} else {
				messages[assistantIndex] = assistantMessage;
			}
		}
		messages.push(...toolResults);
		setContext(messages);
		assistantParts = [];
		toolResults = [];
	};
	const appendMessages = (messages: readonly AgentTurnMessage[]): void => {
		flushModelStep();
		if (messages.length > 0) {
			setContext([...getContext(), ...messages]);
		}
	};
	const appendFollowUpMessages = (
		messages: readonly AgentTurnMessage[]
	): void => {
		appendMessages(messages);
		if (messages.length > 0) {
			assistantSegmentIndex += 1;
		}
	};
	return {
		appendFollowUpMessages,
		appendSteeringMessages: appendMessages,
		observe: (event) => {
			switch (event.type) {
				case "model-step-started":
					break;
				case "text-delta":
					assistantParts.push({ text: event.delta, type: "text" });
					break;
				case "tool-call-started":
					assistantParts.push({
						input: event.input,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						type: "tool-call",
					});
					break;
				case "tool-call-finished": {
					const part: AgentTurnPart =
						event.outcome.type === "success"
							? {
									output: event.outcome.output,
									toolCallId: event.toolCallId,
									toolName: event.toolName,
									type: "tool-result",
								}
							: {
									errorText: event.outcome.errorText,
									...(event.outcome.failure === undefined
										? {}
										: { failure: event.outcome.failure }),
									toolCallId: event.toolCallId,
									toolName: event.toolName,
									type: "tool-failure",
								};
					toolResults.push({
						id: toSessionMessageId(`tool-${event.toolCallId}`),
						parts: [part],
						role: "tool",
					});
					break;
				}
				case "model-step-finished":
				case "agent-turn-completed":
				case "agent-turn-cancelled":
				case "agent-turn-failed":
				case "agent-turn-interrupted":
					flushModelStep();
					break;
				case "agent-turn-started":
					break;
				case "reasoning-delta":
					break;
				default:
					throw new AgentInvariantError(
						"invalid-runtime",
						"Agent Runtime emitted an unknown event."
					);
			}
		},
	};
};

/**
 * Creates the live Agent owner for one loaded conversation. It keeps the
 * current model context and turn lifecycle across invocations while the caller
 * supplies application-owned Session preparation and persistence.
 */
export const createStatefulAgent = ({
	runtime,
}: StatefulAgentOptions): StatefulAgent => {
	let activeController: AbortController | undefined;
	let activeTurnId: AgentTurnId | null = null;
	let closed = false;
	let context: readonly AgentTurnMessage[] = [];
	const followUpMessages: AgentTurnMessage[] = [];
	const steeringMessages: AgentTurnMessage[] = [];
	let lastTerminalEvent: AgentTurnTerminalEvent | null = null;
	let turnCount = 0;
	let idle = Promise.resolve();
	let resolveIdle: (() => void) | undefined;
	const listeners = new Set<() => void>();
	const publish = (): void => {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// Observers cannot change Stateful Agent authority.
			}
		}
	};
	const getSnapshot = (): StatefulAgentSnapshot => ({
		activeTurnId,
		closed,
		context,
		lastTerminalEvent,
		turnCount,
	});
	const abort = (): void => {
		followUpMessages.length = 0;
		steeringMessages.length = 0;
		activeController?.abort();
	};
	const waitForIdle = (): Promise<void> => idle;
	const shutdown = async (): Promise<void> => {
		if (closed) {
			await idle;
			return;
		}
		closed = true;
		abort();
		publish();
		await idle;
	};
	const steer = (message: AgentTurnMessage): void => {
		if (closed) {
			throw new AgentInvariantError(
				"invalid-runtime",
				"A closed Stateful Agent cannot accept a Steering Message."
			);
		}
		steeringMessages.push(message);
	};
	const followUp = (message: AgentTurnMessage): void => {
		if (closed) {
			throw new AgentInvariantError(
				"invalid-runtime",
				"A closed Stateful Agent cannot accept a follow-up message."
			);
		}
		followUpMessages.push(message);
	};
	const assertCanStartTurn = (): void => {
		if (closed) {
			throw new AgentInvariantError(
				"invalid-runtime",
				"A closed Stateful Agent cannot start an Agent Turn."
			);
		}
		if (activeTurnId !== null) {
			throw new AgentInvariantError(
				"invalid-runtime",
				"A Stateful Agent cannot run overlapping Agent Turns."
			);
		}
	};
	const prepareRuntimeTurn = (turn: AgentTurn): AgentTurn => {
		const transientContextId = toSessionMessageId("skill-context");
		const inputMessages = turn.input.messages.filter(
			(message) => message.id !== transientContextId
		);
		const inputIds = new Set(inputMessages.map(({ id }) => id));
		const existingUserIds = new Set(
			context.filter(({ role }) => role === "user").map(({ id }) => id)
		);
		const priorTurnFailed =
			lastTerminalEvent !== null &&
			lastTerminalEvent.type !== "agent-turn-completed";
		const requiresContextRebase =
			context.length === 0 ||
			priorTurnFailed ||
			context.some(({ id }) => !inputIds.has(id));
		if (requiresContextRebase) {
			context = inputMessages;
		} else {
			const newUserMessages = inputMessages.filter(
				(message) => message.role === "user" && !existingUserIds.has(message.id)
			);
			if (newUserMessages.length > 0) {
				context = [...context, ...newUserMessages];
			}
		}
		const runtimeMessages = [...context];
		const transientMessage = turn.input.messages.find(
			(message) => message.id === transientContextId
		);
		if (transientMessage !== undefined) {
			const transientIndex = turn.input.messages.findIndex(
				(message) => message.id === transientContextId
			);
			const followingMessage = turn.input.messages
				.slice(transientIndex + 1)
				.find((message) => message.id !== transientContextId);
			const followingIndex =
				followingMessage === undefined
					? -1
					: runtimeMessages.findIndex(
							(message) => message.id === followingMessage.id
						);
			runtimeMessages.splice(
				followingIndex < 0 ? runtimeMessages.length : followingIndex,
				0,
				transientMessage
			);
		}
		return { ...turn, input: { messages: runtimeMessages } };
	};
	const run = (
		turn: AgentTurn,
		options: AgentRuntimeRunOptions = {}
	): AgentTurnEventStream => {
		const execute = async function* (): AsyncGenerator<
			AgentTurnEvent,
			void,
			undefined
		> {
			assertCanStartTurn();
			const runtimeTurn = prepareRuntimeTurn(turn);
			const controller = new AbortController();
			activeController = controller;
			activeTurnId = turn.id;
			lastTerminalEvent = null;
			turnCount += 1;
			const currentIdle = Promise.withResolvers<void>();
			idle = currentIdle.promise;
			resolveIdle = currentIdle.resolve;
			publish();
			const projector = createAgentTurnContextProjector(
				turn,
				() => context,
				(nextContext) => {
					context = nextContext;
					publish();
				}
			);
			const signal =
				options.signal === undefined
					? controller.signal
					: AbortSignal.any([controller.signal, options.signal]);
			let followUpsAwaitingSteering = EMPTY_AGENT_TURN_MESSAGES;
			const takeRuntimeSteeringMessages = async (): Promise<
				readonly AgentTurnMessage[]
			> => {
				const deferredFollowUps = followUpsAwaitingSteering;
				const steering = await takePreparedAgentTurnMessages({
					append:
						deferredFollowUps.length === 0
							? projector.appendSteeringMessages
							: () => undefined,
					context,
					queue: steeringMessages,
					requested: options.takeSteeringMessages,
				});
				if (deferredFollowUps.length > 0) {
					if (steering.length > 0) {
						projector.appendSteeringMessages(steering);
					}
					projector.appendFollowUpMessages(deferredFollowUps);
					followUpsAwaitingSteering = EMPTY_AGENT_TURN_MESSAGES;
				}
				return steering;
			};
			const takeRuntimeFollowUpMessages = async (): Promise<
				readonly AgentTurnMessage[]
			> => {
				const messages = await takePreparedAgentTurnMessages({
					append: () => undefined,
					context,
					queue: followUpMessages,
					requested: options.takeFollowUpMessages,
				});
				followUpsAwaitingSteering = messages;
				return messages;
			};
			try {
				for await (const event of runtime.run(runtimeTurn, {
					...options,
					signal,
					takeFollowUpMessages: takeRuntimeFollowUpMessages,
					takeSteeringMessages: takeRuntimeSteeringMessages,
				})) {
					projector.observe(event);
					if (
						event.type === "agent-turn-completed" ||
						event.type === "agent-turn-failed" ||
						event.type === "agent-turn-cancelled" ||
						event.type === "agent-turn-interrupted"
					) {
						lastTerminalEvent = event;
						publish();
					}
					yield event;
				}
			} finally {
				if (activeTurnId === turn.id) {
					activeController = undefined;
					activeTurnId = null;
					resolveIdle?.();
					resolveIdle = undefined;
					publish();
				}
			}
		};
		return execute();
	};

	return {
		abort,
		followUp,
		getSnapshot,
		run,
		shutdown,
		steer,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		waitForIdle,
	};
};

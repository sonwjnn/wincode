import type { ModelMessage } from "@ai-sdk/provider-utils";
import type {
	AgentRuntime,
	AgentRuntimeRunOptions,
	AgentTurn,
	AgentTurnEvent,
	AgentTurnEventStream,
	AgentTurnTerminalEvent,
	ModelStepId,
	OperationalFailure,
} from "@wincode/agent-core";
import {
	AgentInvariantError,
	createAgentTurnAbortEvent,
	createAgentTurnLifecycle,
	createOperationalFailure,
	getAgentTurnFailureDetails,
	isAgentInvariantError,
	isAgentTurnTerminalEvent,
} from "@wincode/agent-core";
import type { ModelFailure } from "@wincode/ai/failures";
import { normalizeModelFailure } from "@wincode/ai/failures";
import type { ModelUsage } from "@wincode/ai/model-usage";
import { normalizeModelUsage } from "@wincode/ai/model-usage";
import {
	type ResolvedModel,
	resolveAiSdkModelTarget,
} from "@wincode/ai/server";
import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";

/** Resolves the concrete AI SDK model for one Wincode Model Target. */
export type ResolveAgentModel = (model: AgentTurn["model"]) => ResolvedModel;

/** Default resolver: existing AI SDK provider construction for a Model Target. */
export const defaultResolveAgentModel: ResolveAgentModel = (target) =>
	resolveAiSdkModelTarget(target);

export type TextOnlyAgentRuntimeOptions = {
	/** Overrides the AI SDK model resolver (deterministic tests). */
	resolveModel?: ResolveAgentModel;
};

const STEP_ID_PREFIX = "step";

const noToolSet = {} as ToolSet;

const isAbortLike = (error: unknown): boolean =>
	typeof error === "object" &&
	error !== null &&
	"name" in error &&
	(error as { name?: unknown }).name === "AbortError";

const resolveTerminalFailure = (
	error: unknown,
	turn: AgentTurn
): OperationalFailure => {
	if (isAbortLike(error)) {
		return createOperationalFailure({
			code: "cancelled",
			details: getAgentTurnFailureDetails(turn),
			retry: "never",
			source: "runtime",
		});
	}
	const modelFailure: ModelFailure = normalizeModelFailure(error, {
		modelId: turn.model.modelId,
		providerId: turn.model.providerId,
	});
	return createOperationalFailure({
		code: modelFailure.code,
		details: {
			...getAgentTurnFailureDetails(turn),
			...(modelFailure.details?.retryAfterMs === undefined
				? {}
				: { retryAfterMs: modelFailure.details.retryAfterMs }),
			...(modelFailure.details?.statusCode === undefined
				? {}
				: { statusCode: modelFailure.details.statusCode }),
		},
		retry: modelFailure.retry,
		source: modelFailure.source === "runtime" ? "runtime" : "model",
	});
};

const toModelUsage = (usage: unknown): ModelUsage | undefined =>
	normalizeModelUsage(usage) ?? undefined;

const resolveRuntimeSignal = (
	signal: AbortSignal | undefined,
	deadlineMs: number | undefined
): AbortSignal | undefined => {
	if (deadlineMs === undefined) {
		return signal;
	}
	if (!Number.isInteger(deadlineMs) || deadlineMs < 0) {
		throw new AgentInvariantError(
			"invalid-runtime",
			"Agent Runtime deadline must be a non-negative integer.",
			{ cause: deadlineMs }
		);
	}
	const deadlineSignal = AbortSignal.timeout(deadlineMs);
	return signal === undefined
		? deadlineSignal
		: AbortSignal.any([signal, deadlineSignal]);
};

const createAbortError = (reason: unknown): Error =>
	reason instanceof Error
		? reason
		: new Error("Agent Runtime operation was aborted.", { cause: reason });
const awaitWithAbort = async <Value>(
	operation: Promise<Value>,
	signal: AbortSignal | undefined
): Promise<Value> => {
	if (signal === undefined) {
		return operation;
	}
	if (signal.aborted) {
		void operation.catch(() => undefined);
		throw createAbortError(signal.reason);
	}
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => {
		aborted.reject(createAbortError(signal.reason));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([operation, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
};

const createStoppedEventIfAborted = (
	turn: AgentTurn,
	signal: AbortSignal | undefined,
	sequence: number
): AgentTurnTerminalEvent | undefined =>
	signal?.aborted
		? createAgentTurnAbortEvent(turn, signal, sequence)
		: undefined;

const createInternalAbortFailure = (
	turn: AgentTurn,
	sequence: number
): AgentTurnTerminalEvent => ({
	failure: createOperationalFailure({
		code: "cancelled",
		details: getAgentTurnFailureDetails(turn),
		retry: "never",
		source: "runtime",
	}),
	finishedAt: Date.now(),
	sequence,
	turnId: turn.id,
	type: "agent-turn-failed",
});

type AiSdkTextStreamPart = {
	readonly error?: unknown;
	readonly text?: unknown;
	readonly totalUsage?: unknown;
	readonly type: string;
	readonly usage?: unknown;
};
const isAiSdkTextStreamPart = (
	value: unknown
): value is AiSdkTextStreamPart => {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return false;
	}
	return typeof value.type === "string";
};

type StreamProjectionState = {
	stepId?: ModelStepId;
	stepIndex: number;
};

const requirePartText = (part: AiSdkTextStreamPart): string => {
	if (typeof part.text !== "string") {
		throw new AgentInvariantError(
			"invalid-event",
			"AI SDK emitted a text event without text.",
			{ cause: part }
		);
	}
	return part.text;
};

const projectAiSdkPart = (
	part: AiSdkTextStreamPart,
	turn: AgentTurn,
	resolved: ResolvedModel,
	state: StreamProjectionState,
	runtimeSignal: AbortSignal | undefined,
	sequence: number
): AgentTurnEvent | undefined => {
	switch (part.type) {
		case "start-step": {
			state.stepIndex += 1;
			state.stepId = `${STEP_ID_PREFIX}-${state.stepIndex}`;
			return {
				modelId: resolved.modelId,
				sequence,
				stepId: state.stepId,
				turnId: turn.id,
				type: "model-step-started",
			};
		}
		case "text-delta":
			return {
				delta: requirePartText(part),
				sequence,
				turnId: turn.id,
				type: "text-delta",
			};
		case "reasoning-delta":
			return {
				delta: requirePartText(part),
				sequence,
				turnId: turn.id,
				type: "reasoning-delta",
			};
		case "finish-step":
			return {
				modelId: resolved.modelId,
				sequence,
				stepId: state.stepId ?? `${STEP_ID_PREFIX}-1`,
				turnId: turn.id,
				type: "model-step-finished",
				usage: toModelUsage(part.usage),
			};
		case "finish":
			return {
				finishedAt: Date.now(),
				sequence,
				turnId: turn.id,
				type: "agent-turn-completed",
				usage: toModelUsage(part.totalUsage),
			};
		case "error":
			if (isAgentInvariantError(part.error)) {
				throw part.error;
			}
			return {
				failure: resolveTerminalFailure(part.error, turn),
				finishedAt: Date.now(),
				sequence,
				turnId: turn.id,
				type: "agent-turn-failed",
			};
		case "abort": {
			const stopped = createStoppedEventIfAborted(
				turn,
				runtimeSignal,
				sequence
			);
			return stopped ?? createInternalAbortFailure(turn, sequence);
		}
		default:
			return;
	}
};
const resolveRuntimeModel = (
	resolveModel: ResolveAgentModel,
	model: AgentTurn["model"]
): ResolvedModel => {
	try {
		return resolveModel(model);
	} catch (error) {
		if (isAgentInvariantError(error)) {
			throw error;
		}
		throw new AgentInvariantError(
			"invalid-runtime",
			"Agent Runtime model resolution violated its contract.",
			{ cause: error }
		);
	}
};

const createAgentLoop = (
	agent: AgentTurn["agent"],
	resolved: ResolvedModel
): ToolLoopAgent<never, ToolSet> => {
	try {
		return new ToolLoopAgent<never, ToolSet>({
			activeTools: [],
			instructions: agent.instructions,
			maxOutputTokens: resolved.maxOutputTokens,
			model: resolved.model,
			providerOptions: resolved.providerOptions,
			stopWhen: stepCountIs(1),
			tools: noToolSet,
		});
	} catch (error) {
		if (isAgentInvariantError(error)) {
			throw error;
		}
		throw new AgentInvariantError(
			"invalid-runtime",
			"Agent Runtime could not construct its model loop.",
			{ cause: error }
		);
	}
};

/**
 * The private AI SDK Agent Runtime adapter for text-only turns. It constructs
 * the concrete AI SDK model through existing provider resolution, runs one
 * tool-less ToolLoopAgent Model Step per Agent Turn, and yields only Wincode
 * Agent Turn Events. No AI SDK message, model, stream, callback, transport,
 * or error type crosses the returned event stream.
 */
export const createAiSdkTextOnlyAgentRuntime = (
	options: TextOnlyAgentRuntimeOptions = {}
): AgentRuntime => {
	const resolveModel = options.resolveModel ?? defaultResolveAgentModel;

	const run = (
		turn: AgentTurn,
		runOptions: AgentRuntimeRunOptions = {}
	): AgentTurnEventStream => {
		const iterator = runTextOnlyTurn(turn, runOptions, resolveModel);
		return {
			[Symbol.asyncIterator]: () => iterator,
		};
	};

	return { run };
};

const runTextOnlyTurn = async function* (
	turn: AgentTurn,
	{ deadlineMs, signal }: AgentRuntimeRunOptions,
	resolveModel: ResolveAgentModel
): AsyncGenerator<AgentTurnEvent, void, undefined> {
	const lifecycle = createAgentTurnLifecycle(turn.id);
	const runtimeSignal = resolveRuntimeSignal(signal, deadlineMs);
	let sequence = 0;
	const { agent, model, input } = turn;
	const modelMessages: ModelMessage[] = input.messages.map((message) => ({
		content: message.parts.map((part) => ({
			text: part.text,
			type: "text",
		})),
		role: message.role,
	}));

	const emit = (event: AgentTurnEvent): AgentTurnEvent => {
		lifecycle.apply(event);
		sequence = event.sequence + 1;
		return event;
	};

	yield emit({
		agentId: agent.id,
		sequence,
		startedAt: Date.now(),
		turnId: turn.id,
		type: "agent-turn-started",
	});

	if (runtimeSignal?.aborted) {
		yield emit(
			createAgentTurnAbortEvent(
				turn,
				runtimeSignal,
				lifecycle.getState().lastSequence + 1
			)
		);
		return;
	}

	const resolved = resolveRuntimeModel(resolveModel, model);
	const agentLoop = createAgentLoop(agent, resolved);

	try {
		const result = await awaitWithAbort(
			agentLoop.stream({
				abortSignal: runtimeSignal,
				prompt: modelMessages,
			}),
			runtimeSignal
		);
		const projection: StreamProjectionState = { stepIndex: 0 };
		const iterator = result.fullStream[Symbol.asyncIterator]();

		try {
			while (true) {
				const next = await awaitWithAbort(iterator.next(), runtimeSignal);
				if (next.done) {
					break;
				}
				if (!isAiSdkTextStreamPart(next.value)) {
					throw new AgentInvariantError(
						"invalid-event",
						"AI SDK emitted an invalid stream part.",
						{ cause: next.value }
					);
				}
				const event = projectAiSdkPart(
					next.value,
					turn,
					resolved,
					projection,
					runtimeSignal,
					sequence
				);
				if (event === undefined) {
					continue;
				}
				yield emit(event);
				if (isAgentTurnTerminalEvent(event)) {
					return;
				}
			}
		} finally {
			const closing = iterator.return?.();
			if (closing !== undefined) {
				void closing.catch(() => undefined);
			}
		}

		if (runtimeSignal?.aborted) {
			yield emit(
				createAgentTurnAbortEvent(
					turn,
					runtimeSignal,
					lifecycle.getState().lastSequence + 1
				)
			);
		} else {
			yield lifecycle.interrupt(
				lifecycle.getState().lastSequence + 1,
				"lost-execution"
			);
		}
	} catch (error) {
		if (isAgentInvariantError(error)) {
			throw error;
		}
		if (runtimeSignal?.aborted) {
			yield emit(
				createAgentTurnAbortEvent(
					turn,
					runtimeSignal,
					lifecycle.getState().lastSequence + 1
				)
			);
			return;
		}
		yield emit({
			failure: resolveTerminalFailure(error, turn),
			finishedAt: Date.now(),
			sequence: lifecycle.getState().lastSequence + 1,
			turnId: turn.id,
			type: "agent-turn-failed",
		});
	}
};

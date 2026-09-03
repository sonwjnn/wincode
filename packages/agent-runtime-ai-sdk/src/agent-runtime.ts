import type { ModelMessage } from "@ai-sdk/provider-utils";
import type {
	AgentRuntime,
	AgentRuntimeRunOptions,
	AgentTurn,
	AgentTurnEvent,
	AgentTurnEventStream,
	AgentTurnLifecycle,
	AgentTurnMessage,
	AgentTurnPart,
	AgentTurnTerminalEvent,
	ModelStepId,
	OperationalFailure,
	ResolvedTool,
	ToolCallId,
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
import {
	stepCountIs,
	type ToolExecutionOptions,
	ToolLoopAgent,
	type ToolSet,
	tool,
} from "ai";

/** Resolves the concrete AI SDK model for one Wincode Model Target. */
export type ResolveAgentModel = (model: AgentTurn["model"]) => ResolvedModel;

/** Default resolver: existing AI SDK provider construction for a Model Target. */
export const defaultResolveAgentModel: ResolveAgentModel = (target) =>
	resolveAiSdkModelTarget(target);

export type AgentRuntimeOptions = {
	/** Overrides the AI SDK model resolver (deterministic tests). */
	resolveModel?: ResolveAgentModel;
};

const STEP_ID_PREFIX = "step";
/** Upper bound on Model Steps for one tool-armed Agent Turn (legacy loop default). */
const TOOL_ARMED_STEP_LIMIT = 20;

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
	readonly dynamic?: unknown;
	readonly error?: unknown;
	readonly input?: unknown;
	readonly invalid?: unknown;
	readonly output?: unknown;
	readonly text?: unknown;
	readonly toolCallId?: unknown;
	readonly toolMetadata?: unknown;
	readonly toolName?: unknown;
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
	/** Tool Calls already announced so a lone error part can pair with its start. */
	startedToolCallIds: Set<ToolCallId>;
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

const requirePartToolIdentity = (
	part: AiSdkTextStreamPart
): { toolCallId: string; toolName: string } => {
	if (
		typeof part.toolCallId !== "string" ||
		part.toolCallId.length === 0 ||
		typeof part.toolName !== "string" ||
		part.toolName.length === 0
	) {
		throw new AgentInvariantError(
			"invalid-event",
			"AI SDK emitted a tool event without a tool identity.",
			{ cause: part }
		);
	}
	return { toolCallId: part.toolCallId, toolName: part.toolName };
};

const toolErrorMessage = (error: unknown): string =>
	error instanceof Error && error.message.length > 0
		? error.message
		: "Tool execution failed.";

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
		case "tool-call": {
			const { toolCallId, toolName } = requirePartToolIdentity(part);
			state.startedToolCallIds.add(toolCallId);
			return {
				input: "input" in part ? part.input : undefined,
				sequence,
				toolCallId,
				toolName,
				turnId: turn.id,
				type: "tool-call-started",
			};
		}
		case "tool-result": {
			const { toolCallId, toolName } = requirePartToolIdentity(part);
			return {
				outcome: { output: part.output, type: "success" },
				sequence,
				toolCallId,
				toolName,
				turnId: turn.id,
				type: "tool-call-finished",
			};
		}
		case "tool-error": {
			const { toolCallId, toolName } = requirePartToolIdentity(part);
			state.startedToolCallIds.delete(toolCallId);
			return {
				outcome: { errorText: toolErrorMessage(part.error), type: "failure" },
				sequence,
				toolCallId,
				toolName,
				turnId: turn.id,
				type: "tool-call-finished",
			};
		}
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
const toolCallContent = (part: AgentTurnPart): unknown => {
	if (part.type === "tool-call") {
		return {
			input: part.input,
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			type: "tool-call",
		};
	}
	throw new AgentInvariantError(
		"invalid-runtime",
		"A non-tool part appeared in an assistant tool position.",
		{ cause: part }
	);
};

const toolResultContent = (part: AgentTurnPart): unknown => {
	if (part.type === "tool-result") {
		return {
			output: { type: "json", value: part.output },
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			type: "tool-result",
		};
	}
	if (part.type === "tool-failure") {
		return {
			output: { type: "error-text", value: part.errorText },
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			type: "tool-result",
		};
	}
	throw new AgentInvariantError(
		"invalid-runtime",
		"A non-tool part appeared in a tool message.",
		{ cause: part }
	);
};

const textContent = (part: AgentTurnPart): unknown => {
	if (part.type !== "text") {
		throw new AgentInvariantError(
			"invalid-runtime",
			"A tool part appeared in a text message position.",
			{ cause: part }
		);
	}
	return { text: part.text, type: "text" };
};

const modelContentFor = (
	part: AgentTurnPart,
	role: AgentTurnMessage["role"]
): unknown => {
	if (role === "tool") {
		return toolResultContent(part);
	}
	return part.type === "tool-call" ? toolCallContent(part) : textContent(part);
};

/**
 * Converts Wincode input messages to AI SDK model messages. Assistant
 * messages keep their text and tool-call parts; `tool` role messages carry
 * the Tool Call results the next Model Step must observe.
 */
const toAiSdkModelMessages = (turn: AgentTurn): ModelMessage[] => {
	const modelMessages: ModelMessage[] = [];
	for (const message of turn.input.messages) {
		const content = message.parts.map((part) =>
			modelContentFor(part, message.role)
		);
		const role = message.role;
		modelMessages.push({ content, role } as ModelMessage);
	}
	return modelMessages;
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

const toAiSdkToolSet = (tools: readonly ResolvedTool[]): ToolSet => {
	const set: Record<string, unknown> = {};
	for (const { definition, execute } of tools) {
		if (set[definition.name] !== undefined) {
			throw new AgentInvariantError(
				"invalid-runtime",
				`Agent Turn supplied tool ${definition.name} twice.`,
				{ cause: definition }
			);
		}
		set[definition.name] = tool({
			description: definition.description,
			inputSchema: definition.inputSchema,
			...(definition.outputSchema === undefined
				? {}
				: { outputSchema: definition.outputSchema }),
			execute: async (
				input: unknown,
				options: ToolExecutionOptions
			): Promise<unknown> => {
				const outcome = await execute(
					{ input, toolCallId: options.toolCallId },
					{ signal: options.abortSignal }
				);
				if (outcome.type === "failure") {
					throw new Error(outcome.errorText);
				}
				return outcome.output;
			},
		});
	}
	return set as ToolSet;
};

const createAgentLoop = (
	agent: AgentTurn["agent"],
	resolved: ResolvedModel,
	tools: readonly ResolvedTool[]
): ToolLoopAgent<never, ToolSet> => {
	const toolArmed = tools.length > 0;
	try {
		return new ToolLoopAgent<never, ToolSet>({
			activeTools: toolArmed
				? tools.map(({ definition }) => definition.name)
				: [],
			instructions: agent.instructions,
			maxOutputTokens: resolved.maxOutputTokens,
			model: resolved.model,
			providerOptions: resolved.providerOptions,
			stopWhen: stepCountIs(toolArmed ? TOOL_ARMED_STEP_LIMIT : 1),
			tools: toolArmed ? toAiSdkToolSet(tools) : noToolSet,
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
 * The private AI SDK Agent Runtime adapter. It constructs the concrete AI SDK
 * model through existing provider resolution, runs one ToolLoopAgent per
 * Agent Turn (tool-less turns run exactly one Model Step; tool-armed turns
 * run up to TOOL_ARMED_STEP_LIMIT steps with the turn's gated Resolved
 * Tools), and yields only Wincode Agent Turn Events. No AI SDK message,
 * model, stream, callback, transport, or error type crosses the returned
 * event stream, and no Tool family branch exists here: tools are declared
 * through Agent Core Tool contracts and executed through their gate-wrapped
 * executors.
 */
export const createAiSdkAgentRuntime = (
	options: AgentRuntimeOptions = {}
): AgentRuntime => {
	const resolveModel = options.resolveModel ?? defaultResolveAgentModel;

	const run = (
		turn: AgentTurn,
		runOptions: AgentRuntimeRunOptions = {}
	): AgentTurnEventStream => {
		const iterator = runAgentTurn(turn, runOptions, resolveModel);
		return {
			[Symbol.asyncIterator]: () => iterator,
		};
	};

	return { run };
};

const runAgentTurn = async function* (
	turn: AgentTurn,
	{ deadlineMs, signal }: AgentRuntimeRunOptions,
	resolveModel: ResolveAgentModel
): AsyncGenerator<AgentTurnEvent, void, undefined> {
	const lifecycle = createAgentTurnLifecycle(turn.id);
	const runtimeSignal = resolveRuntimeSignal(signal, deadlineMs);
	let sequence = 0;
	const { agent, model } = turn;
	const tools = turn.tools ?? [];
	const modelMessages = toAiSdkModelMessages(turn);

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
	const agentLoop = createAgentLoop(agent, resolved, tools);

	try {
		const result = await awaitWithAbort(
			agentLoop.stream({
				abortSignal: runtimeSignal,
				prompt: modelMessages,
			}),
			runtimeSignal
		);
		const projection: StreamProjectionState = {
			startedToolCallIds: new Set<ToolCallId>(),
			stepIndex: 0,
		};
		const iterator = result.fullStream[Symbol.asyncIterator]();
		const terminal = yield* drainAgentStreamParts({
			emit,
			iterator,
			lifecycle,
			projection,
			resolved,
			runtimeSignal,
			turn,
		});
		if (terminal) {
			return;
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

type AgentTurnStreamEmit = (event: AgentTurnEvent) => AgentTurnEvent;

const closeModelStream = (iterator: AsyncIterator<unknown>): void => {
	const closing = iterator.return?.();
	if (closing !== undefined) {
		void closing.catch(() => undefined);
	}
};

/**
 * Drains one AI SDK model stream, projecting every part to Agent Turn Events
 * through `projectAiSdkPart`. Returns true when a terminal Agent Turn Event
 * ended the stream; the stream iterator is closed on every exit path.
 */
const drainAgentStreamParts = async function* ({
	emit,
	iterator,
	lifecycle,
	projection,
	resolved,
	runtimeSignal,
	turn,
}: {
	emit: AgentTurnStreamEmit;
	iterator: AsyncIterator<AiSdkTextStreamPart>;
	lifecycle: AgentTurnLifecycle;
	projection: StreamProjectionState;
	resolved: ResolvedModel;
	runtimeSignal: AbortSignal | undefined;
	turn: AgentTurn;
}): AsyncGenerator<AgentTurnEvent, boolean, undefined> {
	try {
		while (true) {
			const next = await awaitWithAbort(iterator.next(), runtimeSignal);
			if (next.done) {
				return false;
			}
			if (!isAiSdkTextStreamPart(next.value)) {
				throw new AgentInvariantError(
					"invalid-event",
					"AI SDK emitted an invalid stream part.",
					{ cause: next.value }
				);
			}
			const part = next.value;
			if (part.type === "tool-error") {
				// A Tool Call that never announced its start (invalid input,
				// provider-side failure) still yields one started event so the
				// identity contract of the event stream holds for every Tool
				// Call outcome.
				const identity = requirePartToolIdentity(part);
				if (!projection.startedToolCallIds.has(identity.toolCallId)) {
					yield emit({
						input: "input" in part ? part.input : undefined,
						sequence: lifecycle.getState().lastSequence + 1,
						toolCallId: identity.toolCallId,
						toolName: identity.toolName,
						turnId: turn.id,
						type: "tool-call-started",
					});
				}
			}
			const event = projectAiSdkPart(
				part,
				turn,
				resolved,
				projection,
				runtimeSignal,
				lifecycle.getState().lastSequence + 1
			);
			if (event === undefined) {
				continue;
			}
			yield emit(event);
			if (isAgentTurnTerminalEvent(event)) {
				return true;
			}
		}
	} finally {
		closeModelStream(iterator);
	}
};

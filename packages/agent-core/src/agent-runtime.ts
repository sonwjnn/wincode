import type {
	ModelClient,
	ModelPromptMessage,
	ModelStepRequest,
	ModelStreamPart,
	ModelTool,
} from "@wincode/ai/model-client";
import {
	type ModelFailure,
	normalizeModelFailure,
} from "@wincode/ai/model-failures";
import { type ModelUsage, normalizeModelUsage } from "@wincode/ai/model-usage";
import {
	getErrorMessage,
	isError,
	isNonEmptyString,
	isObjectLike,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import type { JsonObject } from "type-fest";
import { z } from "zod";
import { AgentInvariantError, isAgentInvariantError } from "./errors";
import type { AgentTurnEvent, AgentTurnTerminalEvent } from "./events";
import type { OperationalFailure } from "./failures";
import { createOperationalFailure } from "./failures";
import { toModelStepId } from "./identifiers";
import { type AgentTurnLifecycle, createAgentTurnLifecycle } from "./lifecycle";
import {
	type AgentRuntime,
	type AgentRuntimeRunOptions,
	type AgentTurnEventStream,
	createAgentTurnAbortEvent,
	getAgentTurnFailureDetails,
} from "./runtime";
import {
	isToolCallId,
	isToolCallOutput,
	isToolFailureDetails,
	type ResolvedTool,
	type ToolCallId,
	type ToolCallOutput,
} from "./tools";
import type { AgentTurn, AgentTurnMessage, AgentTurnPart } from "./turn";

const TOOL_ARMED_STEP_LIMIT = 20;

export type AgentRuntimeOptions = Readonly<{
	/** Provider-neutral Model Client stream consumed by this runtime. */
	modelClient: ModelClient;
}>;

const isAbortLike = (error: unknown): boolean =>
	isObjectLike(error) && "name" in error && error.name === "AbortError";

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
			...omitUndefined({
				retryAfterMs: modelFailure.details?.retryAfterMs,
				statusCode: modelFailure.details?.statusCode,
			}),
		},
		retry: modelFailure.retry,
		source: modelFailure.source === "runtime" ? "runtime" : "model",
	});
};

const resolveRuntimeSignal = (
	signal: AbortSignal | undefined,
	deadlineMs: number | undefined
): AbortSignal | undefined => {
	if (isUndefined(deadlineMs)) {
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
	return isUndefined(signal)
		? deadlineSignal
		: AbortSignal.any([signal, deadlineSignal]);
};

const createAbortError = (reason: unknown): Error =>
	isError(reason)
		? reason
		: new Error("Agent Runtime operation was aborted.", { cause: reason });

const awaitWithAbort = async <Value>(
	operation: Promise<Value>,
	signal: AbortSignal | undefined
): Promise<Value> => {
	if (isUndefined(signal)) {
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

const closeModelStream = (iterator: AsyncIterator<ModelStreamPart>): void => {
	const closing = iterator.return?.();
	if (!isUndefined(closing)) {
		void closing.catch(() => undefined);
	}
};

const modelPromptMessage = (message: AgentTurnMessage): ModelPromptMessage => ({
	content: message.parts,
	role: message.role,
});

const toModelTool = (tool: ResolvedTool): ModelTool => {
	const inputSchema = tool.definition.inputSchema;
	const jsonSchema =
		"jsonSchema" in inputSchema
			? inputSchema.jsonSchema
			: (z.toJSONSchema(inputSchema) as JsonObject);
	return {
		description: tool.definition.description,
		inputSchema: jsonSchema,
		name: tool.definition.name,
	};
};

const validateToolInput = async (
	tool: ResolvedTool,
	input: unknown
): Promise<
	{ error: Error; success: false } | { success: true; value: unknown }
> => {
	const schema = tool.definition.inputSchema;
	if ("jsonSchema" in schema) {
		if (isUndefined(schema.validate)) {
			return { success: true, value: input };
		}
		const result = await schema.validate(input);
		return result.success ? result : { error: result.error, success: false };
	}
	const result = schema.safeParse(input);
	return result.success
		? { success: true, value: result.data }
		: { error: result.error, success: false };
};

const toolFailureDetailsFrom = (error: unknown) => {
	if (isObjectLike(error) && "failure" in error) {
		return isToolFailureDetails(error.failure) ? error.failure : undefined;
	}
};

const executeToolCall = async (
	tool: ResolvedTool,
	call: Readonly<{ input: unknown; toolCallId: ToolCallId }>,
	signal: AbortSignal | undefined
): Promise<ToolCallOutput> => {
	try {
		const parsed = await validateToolInput(tool, call.input);
		if (!parsed.success) {
			return { errorText: "Tool call input was invalid.", type: "failure" };
		}
		const output = await tool.execute(
			{ input: parsed.value, toolCallId: call.toolCallId },
			{ signal }
		);
		if (!isToolCallOutput(output)) {
			throw new AgentInvariantError(
				"invalid-runtime",
				`Tool ${tool.definition.name} returned an invalid outcome.`,
				{ cause: output }
			);
		}
		return output;
	} catch (error) {
		if (isAgentInvariantError(error)) {
			throw error;
		}
		const failure = toolFailureDetailsFrom(error);
		return {
			errorText: getErrorMessage(error, "Tool execution failed."),
			...omitUndefined({ failure }),
			type: "failure",
		};
	}
};

const isModelStreamPart = (value: unknown): value is ModelStreamPart => {
	if (!(isObjectLike(value) && "type" in value && isString(value.type))) {
		return false;
	}
	switch (value.type) {
		case "text-delta":
		case "reasoning-delta":
			return "delta" in value && isString(value.delta);
		case "tool-call":
			return (
				"input" in value &&
				"toolCallId" in value &&
				isString(value.toolCallId) &&
				"toolName" in value &&
				isString(value.toolName)
			);
		case "finish":
			return true;
		default:
			return false;
	}
};

const sumUsage = (
	current: ModelUsage | undefined,
	next: ModelUsage | undefined
): ModelUsage | undefined => {
	if (isUndefined(next)) {
		return current;
	}
	if (isUndefined(current)) {
		return {
			...next,
			totalTokens: next.inputTokens + next.outputTokens,
		};
	}
	const cacheReadTokens =
		isUndefined(current.cacheReadTokens) && isUndefined(next.cacheReadTokens)
			? undefined
			: (current.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
	const cacheWriteTokens =
		isUndefined(current.cacheWriteTokens) && isUndefined(next.cacheWriteTokens)
			? undefined
			: (current.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0);
	const reasoningTokens =
		isUndefined(current.reasoningTokens) && isUndefined(next.reasoningTokens)
			? undefined
			: (current.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
	const inputTokens = current.inputTokens + next.inputTokens;
	const outputTokens = current.outputTokens + next.outputTokens;
	return {
		inputTokens,
		outputTokens,
		totalTokens: inputTokens + outputTokens,
		...omitUndefined({ cacheReadTokens, cacheWriteTokens, reasoningTokens }),
	};
};

const appendTextPart = (parts: AgentTurnPart[], text: string): void => {
	if (text.length > 0) {
		parts.push({ text, type: "text" });
	}
};

type PendingToolCall = Readonly<{
	input: unknown;
	tool: ResolvedTool;
	toolCallId: ToolCallId;
}>;

const toAgentTurnTerminalEvent = (
	turn: AgentTurn,
	error: unknown,
	sequence: number
): AgentTurnTerminalEvent => ({
	failure: resolveTerminalFailure(error, turn),
	finishedAt: Date.now(),
	sequence,
	turnId: turn.id,
	type: "agent-turn-failed",
});

export const createAgentRuntime = ({
	modelClient,
}: AgentRuntimeOptions): AgentRuntime => {
	const run = (
		turn: AgentTurn,
		runOptions: AgentRuntimeRunOptions = {}
	): AgentTurnEventStream => runAgentTurn(turn, runOptions, modelClient);
	return { run };
};

type ModelStepOutput = Readonly<{
	assistantParts: readonly AgentTurnPart[];
	continuation?: unknown;
	toolCalls: readonly PendingToolCall[];
	usage?: ModelUsage;
}>;

type EventEmitter = ((event: AgentTurnEvent) => AgentTurnEvent) & {
	nextSequence: () => number;
};

type ModelStepStreamOptions = Readonly<{
	emit: EventEmitter;
	modelClient: ModelClient;
	request: ModelStepRequest;
	seenToolCallIds: Set<ToolCallId>;
	signal?: AbortSignal;
	toolsByName: ReadonlyMap<string, ResolvedTool>;
	turnId: AgentTurn["id"];
}>;

const resolveToolCall = (
	part: Extract<ModelStreamPart, { type: "tool-call" }>,
	toolsByName: ReadonlyMap<string, ResolvedTool>,
	seenToolCallIds: Set<ToolCallId>
): PendingToolCall => {
	if (!(isToolCallId(part.toolCallId) && isNonEmptyString(part.toolName))) {
		throw new AgentInvariantError(
			"invalid-event",
			"Model client emitted a tool call without an identity.",
			{ cause: part }
		);
	}
	const tool = toolsByName.get(part.toolName);
	if (!tool) {
		throw new AgentInvariantError(
			"tool-not-found",
			`Model requested inactive tool ${part.toolName}.`,
			{ cause: part }
		);
	}
	if (seenToolCallIds.has(part.toolCallId)) {
		throw new AgentInvariantError(
			"invalid-event",
			`Model reused Tool Call identifier ${part.toolCallId}.`,
			{ cause: part }
		);
	}
	seenToolCallIds.add(part.toolCallId);
	return { input: part.input, tool, toolCallId: part.toolCallId };
};

const drainModelStep = async function* ({
	emit,
	modelClient,
	request,
	seenToolCallIds,
	signal,
	toolsByName,
	turnId,
}: ModelStepStreamOptions): AsyncGenerator<
	AgentTurnEvent,
	ModelStepOutput | null,
	undefined
> {
	const iterator = modelClient.stream(request)[Symbol.asyncIterator]();
	const assistantParts: AgentTurnPart[] = [];
	const toolCalls: PendingToolCall[] = [];
	let bufferedText = "";
	let usage: ModelUsage | undefined;
	let continuation: unknown;
	let finished = false;
	try {
		while (true) {
			const next = await awaitWithAbort(iterator.next(), signal);
			if (next.done) {
				break;
			}
			if (!isModelStreamPart(next.value)) {
				throw new AgentInvariantError(
					"invalid-event",
					"Model client emitted an invalid stream part.",
					{ cause: next.value }
				);
			}
			const part = next.value;
			if (finished) {
				throw new AgentInvariantError(
					"invalid-event",
					"Model client emitted a stream part after finishing a step.",
					{ cause: part }
				);
			}
			switch (part.type) {
				case "text-delta":
					bufferedText += part.delta;
					yield emit({
						delta: part.delta,
						sequence: emit.nextSequence(),
						turnId,
						type: "text-delta",
					});
					break;
				case "reasoning-delta":
					yield emit({
						delta: part.delta,
						sequence: emit.nextSequence(),
						turnId,
						type: "reasoning-delta",
					});
					break;
				case "tool-call": {
					const call = resolveToolCall(part, toolsByName, seenToolCallIds);
					appendTextPart(assistantParts, bufferedText);
					bufferedText = "";
					toolCalls.push(call);
					assistantParts.push({
						input: call.input,
						toolCallId: call.toolCallId,
						toolName: call.tool.definition.name,
						type: "tool-call",
					});
					yield emit({
						input: call.input,
						sequence: emit.nextSequence(),
						toolCallId: call.toolCallId,
						toolName: call.tool.definition.name,
						turnId,
						type: "tool-call-started",
					});
					break;
				}
				case "finish":
					finished = true;
					usage = normalizeModelUsage(part.usage) ?? undefined;
					continuation = part.continuation;
					break;
				default:
					throw new AgentInvariantError(
						"invalid-event",
						"Model client emitted an unknown stream part.",
						{ cause: part }
					);
			}
		}
	} finally {
		closeModelStream(iterator);
	}
	if (!finished) {
		return null;
	}
	appendTextPart(assistantParts, bufferedText);
	return {
		assistantParts,
		...omitUndefined({ continuation, usage }),
		toolCalls,
	};
};

type ExecuteToolCallsOptions = Readonly<{
	calls: readonly PendingToolCall[];
	emit: EventEmitter;
	signal?: AbortSignal;
	turnId: AgentTurn["id"];
}>;

const executeToolCalls = async function* ({
	calls,
	emit,
	signal,
	turnId,
}: ExecuteToolCallsOptions): AsyncGenerator<
	AgentTurnEvent,
	readonly ModelPromptMessage[],
	undefined
> {
	const outcomes = await awaitWithAbort(
		Promise.all(
			calls.map((call) =>
				executeToolCall(
					call.tool,
					{ input: call.input, toolCallId: call.toolCallId },
					signal
				)
			)
		),
		signal
	);
	const messages: ModelPromptMessage[] = [];
	for (const [index, call] of calls.entries()) {
		const outcome = outcomes[index];
		if (isUndefined(outcome)) {
			throw new AgentInvariantError(
				"invalid-runtime",
				"Tool execution did not produce an outcome.",
				{ cause: call }
			);
		}
		yield emit({
			outcome,
			sequence: emit.nextSequence(),
			toolCallId: call.toolCallId,
			toolName: call.tool.definition.name,
			turnId,
			type: "tool-call-finished",
		});
		const resultPart: AgentTurnPart =
			outcome.type === "success"
				? {
						output: outcome.output,
						toolCallId: call.toolCallId,
						toolName: call.tool.definition.name,
						type: "tool-result",
					}
				: {
						errorText: outcome.errorText,
						...omitUndefined({ failure: outcome.failure }),
						toolCallId: call.toolCallId,
						toolName: call.tool.definition.name,
						type: "tool-failure",
					};
		messages.push({ content: [resultPart], role: "tool" });
	}
	return messages;
};

const createToolsByName = (
	tools: readonly ResolvedTool[]
): ReadonlyMap<string, ResolvedTool> => {
	const toolsByName = new Map<string, ResolvedTool>();
	for (const tool of tools) {
		if (toolsByName.has(tool.definition.name)) {
			throw new AgentInvariantError(
				"invalid-runtime",
				`Agent Turn supplied tool ${tool.definition.name} twice.`,
				{ cause: tool.definition }
			);
		}
		toolsByName.set(tool.definition.name, tool);
	}
	return toolsByName;
};

type ExecuteModelStepsOptions = Readonly<{
	emit: EventEmitter;
	lifecycle: AgentTurnLifecycle;
	modelClient: ModelClient;
	modelMessages: ModelPromptMessage[];
	runtimeSignal?: AbortSignal;
	takeSteeringMessages?: AgentRuntimeRunOptions["takeSteeringMessages"];
	tools: readonly ResolvedTool[];
	toolsByName: ReadonlyMap<string, ResolvedTool>;
	turn: AgentTurn;
}>;

const executeModelSteps = async function* ({
	emit,
	lifecycle,
	modelClient,
	modelMessages,
	runtimeSignal,
	takeSteeringMessages,
	tools,
	toolsByName,
	turn,
}: ExecuteModelStepsOptions): AsyncGenerator<AgentTurnEvent, void, undefined> {
	let totalUsage: ModelUsage | undefined;
	const seenToolCallIds = new Set<ToolCallId>();
	const toolDefinitions = tools.map(toModelTool);
	const stepLimit = tools.length > 0 ? TOOL_ARMED_STEP_LIMIT : 1;
	for (let stepNumber = 1; stepNumber <= stepLimit; stepNumber += 1) {
		if (runtimeSignal?.aborted) {
			yield emit(
				createAgentTurnAbortEvent(turn, runtimeSignal, emit.nextSequence())
			);
			return;
		}
		if (stepNumber > 1 && takeSteeringMessages) {
			modelMessages.push(...takeSteeringMessages().map(modelPromptMessage));
		}
		const stepId = toModelStepId(`step-${stepNumber}`);
		yield emit({
			modelId: turn.model.modelId,
			sequence: emit.nextSequence(),
			stepId,
			turnId: turn.id,
			type: "model-step-started",
		});
		const request: ModelStepRequest = {
			messages: modelMessages,
			...omitUndefined({ signal: runtimeSignal }),
			system: turn.agent.instructions,
			target: turn.model,
			tools: toolDefinitions,
		};
		const output = yield* drainModelStep({
			emit,
			modelClient,
			request,
			seenToolCallIds,
			...omitUndefined({ signal: runtimeSignal }),
			toolsByName,
			turnId: turn.id,
		});
		if (output === null) {
			yield lifecycle.interrupt(emit.nextSequence(), "lost-execution");
			return;
		}
		if (output.toolCalls.length > 0) {
			modelMessages.push({
				...omitUndefined({ continuation: output.continuation }),
				content: output.assistantParts,
				role: "assistant",
			});
			modelMessages.push(
				...(yield* executeToolCalls({
					calls: output.toolCalls,
					emit,
					...omitUndefined({ signal: runtimeSignal }),
					turnId: turn.id,
				}))
			);
		}
		yield emit({
			modelId: turn.model.modelId,
			sequence: emit.nextSequence(),
			stepId,
			turnId: turn.id,
			type: "model-step-finished",
			...omitUndefined({ usage: output.usage }),
		});
		totalUsage = sumUsage(totalUsage, output.usage);
		if (output.toolCalls.length === 0 || stepNumber === stepLimit) {
			yield emit({
				finishedAt: Date.now(),
				sequence: emit.nextSequence(),
				turnId: turn.id,
				type: "agent-turn-completed",
				...omitUndefined({ usage: totalUsage }),
			});
			return;
		}
	}
};

const runAgentTurn = async function* (
	turn: AgentTurn,
	{ deadlineMs, signal, takeSteeringMessages }: AgentRuntimeRunOptions,
	modelClient: ModelClient
): AsyncGenerator<AgentTurnEvent, void, undefined> {
	const lifecycle = createAgentTurnLifecycle(turn.id);
	const runtimeSignal = resolveRuntimeSignal(signal, deadlineMs);
	const tools = turn.tools ?? [];
	const toolsByName = createToolsByName(tools);
	const modelMessages = turn.input.messages.map(modelPromptMessage);
	const emit: EventEmitter = Object.assign(
		(event: AgentTurnEvent) => {
			lifecycle.apply(event);
			return event;
		},
		{ nextSequence: () => lifecycle.getState().lastSequence + 1 }
	);
	yield emit({
		agentId: turn.agent.id,
		...omitUndefined({ delegation: turn.delegation }),
		sequence: emit.nextSequence(),
		startedAt: Date.now(),
		turnId: turn.id,
		type: "agent-turn-started",
	});
	if (runtimeSignal?.aborted) {
		yield emit(
			createAgentTurnAbortEvent(turn, runtimeSignal, emit.nextSequence())
		);
		return;
	}
	try {
		yield* executeModelSteps({
			emit,
			lifecycle,
			modelClient,
			modelMessages,
			...omitUndefined({ runtimeSignal, takeSteeringMessages }),
			tools,
			toolsByName,
			turn,
		});
	} catch (error) {
		if (isAgentInvariantError(error)) {
			throw error;
		}
		if (runtimeSignal?.aborted) {
			yield emit(
				createAgentTurnAbortEvent(turn, runtimeSignal, emit.nextSequence())
			);
			return;
		}
		yield emit(toAgentTurnTerminalEvent(turn, error, emit.nextSequence()));
	}
};

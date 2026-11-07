import { setTimeout as sleep } from "node:timers/promises";
import type {
	ChatEvent,
	ChatFailure,
	ChatMessage,
	ChatRequest,
	ChatTool,
	ProviderCollection,
	ProviderGenerationCompletion,
} from "@wincode/ai";
import {
	type ModelFailure,
	type ModelUsage,
	normalizeModelFailure,
	normalizeModelUsage,
} from "@wincode/ai";
import {
	getErrorMessage,
	isError,
	isNonEmptyString,
	isObjectLike,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import type { JsonObject } from "type-fest";
import { z } from "zod";
import { AgentInvariantError, isAgentInvariantError } from "./errors";
import type { AgentTurnEvent, AgentTurnTerminalEvent } from "./events";
import type { OperationalFailure } from "./failures";
import { createOperationalFailure } from "./failures";
import { type ModelStepId, toModelStepId } from "./identifiers";
import { createAgentTurnLifecycle } from "./lifecycle";
import { resolveModelRetryDelay } from "./model-retry";
import {
	MODEL_STEP_ATTEMPT_CONTENT_LIMIT,
	MODEL_STEP_ATTEMPT_SUMMARY_LIMIT,
	type ModelStepAttemptPartialOutput,
	type ModelStepAttemptSummary,
} from "./model-step";
import {
	type AgentRuntime,
	type AgentRuntimeRunOptions,
	type AgentTurnEventStream,
	createAgentTurnAbortEvent,
	getAgentTurnAbortDisposition,
	getAgentTurnFailureDetails,
	type ModelRetryPolicy,
	type ModelRetryStatus,
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

export type AgentRuntimeOptions = Readonly<{
	/** Direct public SDK invocation; model identity carries no authorization. */
	providerCollection: ProviderCollection;
}>;

type AgentModelInvocation = Readonly<{
	providerCollection: ProviderCollection;
}>;

class ProviderCollectionChatAbortedError extends Error {
	constructor() {
		super("SDK provider request was aborted.");
		this.name = "ProviderCollectionChatAbortedError";
	}
}

class ProviderCollectionChatFailureError extends Error {
	readonly failure: ChatFailure;

	constructor(failure: ChatFailure) {
		super(
			failure.code === "authentication" || failure.code === "credential-store"
				? "SDK provider authorization failed."
				: "SDK provider request failed."
		);
		this.name = "ProviderCollectionChatFailureError";
		this.failure = failure;
	}
}

class ModelStepStreamFailure extends Error {
	readonly partialOutput: ModelStepAttemptPartialOutput | undefined;
	readonly usage: ModelUsage | undefined;

	constructor(
		cause: unknown,
		usage: ModelUsage | undefined,
		partialOutput: ModelStepAttemptPartialOutput | undefined
	) {
		super("Provider Model Step failed.", { cause });
		this.name = "ModelStepStreamFailure";
		this.partialOutput = partialOutput;
		this.usage = usage;
	}
}

class ModelStepRetryFailure extends Error {
	readonly attempts: readonly ModelStepAttemptSummary[];
	readonly terminalFailure: OperationalFailure;
	readonly usage: ModelUsage | undefined;

	constructor(
		cause: unknown,
		{
			attempts,
			terminalFailure,
			usage,
		}: {
			attempts: readonly ModelStepAttemptSummary[];
			terminalFailure: OperationalFailure;
			usage: ModelUsage | undefined;
		}
	) {
		super("Agent Runtime Model retry sequence stopped.", { cause });
		this.name = "ModelStepRetryFailure";
		this.attempts = attempts;
		this.terminalFailure = terminalFailure;
		this.usage = usage;
	}
}

class AgentRuntimeExecutionFailure extends Error {
	readonly usage: ModelUsage | undefined;

	constructor(cause: unknown, usage: ModelUsage | undefined) {
		super("Agent Runtime execution failed.", { cause });
		this.name = "AgentRuntimeExecutionFailure";
		this.usage = usage;
	}
}

const unwrapAgentRuntimeError = (error: unknown): unknown => {
	let current = error;
	while (
		current instanceof ModelStepStreamFailure ||
		current instanceof ModelStepRetryFailure ||
		current instanceof AgentRuntimeExecutionFailure
	) {
		current = current.cause;
	}
	return current;
};

const isAbortLike = (error: unknown): boolean =>
	isObjectLike(error) && "name" in error && error.name === "AbortError";

const resolveTerminalFailure = (
	error: unknown,
	turn: AgentTurn
): OperationalFailure => {
	let current = error;
	while (
		current instanceof ModelStepStreamFailure ||
		current instanceof ModelStepRetryFailure ||
		current instanceof AgentRuntimeExecutionFailure
	) {
		if (current instanceof ModelStepRetryFailure) {
			return current.terminalFailure;
		}
		current = current.cause;
	}
	const normalizedError = unwrapAgentRuntimeError(error);
	if (
		normalizedError instanceof ProviderCollectionChatAbortedError ||
		isAbortLike(normalizedError)
	) {
		return createOperationalFailure({
			code: "cancelled",
			details: getAgentTurnFailureDetails(turn),
			retry: "never",
			source: "runtime",
		});
	}
	if (normalizedError instanceof ProviderCollectionChatFailureError) {
		if (normalizedError.failure.code === "provider") {
			const modelFailure =
				normalizedError.failure.modelFailure ??
				normalizeModelFailure(normalizedError.failure, {
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
				source: "model",
			});
		}
		const mapping = {
			authentication: { code: "authentication", retry: "never" },
			"credential-store": { code: "unknown", retry: "never" },
			"oauth-refresh": { code: "authentication", retry: "never" },
			"model-not-found": { code: "invalid-request", retry: "never" },
			"provider-not-found": { code: "invalid-request", retry: "never" },
			provider: { code: "unknown", retry: "never" },
			transport: { code: "network", retry: "after-delay" },
			"unsupported-capability": { code: "invalid-request", retry: "never" },
		} as const;
		const mapped = mapping[normalizedError.failure.code];
		return createOperationalFailure({
			code: mapped.code,
			details: {
				...getAgentTurnFailureDetails(turn),
				...omitUndefined({
					retryAfterMs:
						"retryAfterMs" in normalizedError.failure
							? normalizedError.failure.retryAfterMs
							: undefined,
				}),
			},
			retry: mapped.retry,
			source: "model",
		});
	}
	const modelFailure: ModelFailure = normalizeModelFailure(normalizedError, {
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

const MAX_RUNTIME_DEADLINE_MS = 2_147_483_647;

type RuntimeSignalLease = Readonly<{
	dispose: () => void;
	signal: AbortSignal | undefined;
}>;

const resolveRuntimeSignal = (
	signal: AbortSignal | undefined,
	deadlineMs: number | undefined
): RuntimeSignalLease => {
	if (isUndefined(deadlineMs)) {
		return { dispose: () => undefined, signal };
	}
	if (
		!Number.isSafeInteger(deadlineMs) ||
		deadlineMs < 0 ||
		deadlineMs > MAX_RUNTIME_DEADLINE_MS
	) {
		throw new AgentInvariantError(
			"invalid-runtime",
			"Agent Runtime deadline must be a non-negative integer within the timer limit.",
			{ cause: deadlineMs }
		);
	}
	const deadlineController = new AbortController();
	const runtimeSignal = isUndefined(signal)
		? deadlineController.signal
		: AbortSignal.any([signal, deadlineController.signal]);
	const deadlineTimer =
		deadlineMs === 0
			? undefined
			: setTimeout(
					() =>
						deadlineController.abort(
							new DOMException(
								"Agent Runtime deadline exceeded",
								"TimeoutError"
							)
						),
					deadlineMs
				);
	if (deadlineMs === 0) {
		deadlineController.abort(
			new DOMException("Agent Runtime deadline exceeded", "TimeoutError")
		);
	}
	const dispose = (): void => {
		if (deadlineTimer !== undefined) {
			clearTimeout(deadlineTimer);
		}
		runtimeSignal.removeEventListener("abort", dispose);
	};
	if (runtimeSignal.aborted) {
		dispose();
	} else {
		runtimeSignal.addEventListener("abort", dispose, { once: true });
	}
	return { dispose, signal: runtimeSignal };
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

const closeModelStream = async (
	iterator: AsyncIterator<unknown>
): Promise<void> => {
	const closing = iterator.return?.();
	await closing?.catch(() => undefined);
};

const modelPromptMessage = (message: AgentTurnMessage): ChatMessage => ({
	content: message.parts,
	role: message.role,
});

export const toModelTool = (tool: ResolvedTool): ChatTool => {
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

const isChatEvent = (value: unknown): value is ChatEvent => {
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
		case "usage":
			return "usage" in value && isObjectLike(value.usage);
		case "terminal":
			return (
				"outcome" in value &&
				isObjectLike(value.outcome) &&
				"status" in value.outcome &&
				(value.outcome.status === "success" ||
					value.outcome.status === "failure" ||
					value.outcome.status === "aborted")
			);
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

const summarizePartialOutput = (
	parts: readonly AgentTurnPart[],
	bufferedText: string,
	bufferedReasoning: string
): ModelStepAttemptPartialOutput | undefined => {
	const text = [
		...parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		bufferedText,
	].join("");
	const truncated =
		text.length > MODEL_STEP_ATTEMPT_CONTENT_LIMIT ||
		bufferedReasoning.length > MODEL_STEP_ATTEMPT_CONTENT_LIMIT;
	const partialOutput = {
		...(text.length === 0
			? {}
			: { text: text.slice(0, MODEL_STEP_ATTEMPT_CONTENT_LIMIT) }),
		...(bufferedReasoning.length === 0
			? {}
			: {
					reasoning: bufferedReasoning.slice(
						0,
						MODEL_STEP_ATTEMPT_CONTENT_LIMIT
					),
				}),
		...(truncated ? { truncated: true as const } : {}),
	};
	return Object.keys(partialOutput).length === 0 ? undefined : partialOutput;
};

type PendingToolCall = Readonly<{
	input: unknown;
	tool: ResolvedTool;
	toolCallId: ToolCallId;
}>;

const toAgentTurnTerminalEvent = (
	turn: AgentTurn,
	error: unknown,
	sequence: number,
	usage?: ModelUsage
): AgentTurnTerminalEvent => ({
	failure: resolveTerminalFailure(error, turn),
	finishedAt: Date.now(),
	sequence,
	turnId: turn.id,
	type: "agent-turn-failed",
	...omitUndefined({ usage }),
});

const terminalEventWithUsage = (
	event: AgentTurnTerminalEvent,
	usage: ModelUsage | undefined
): AgentTurnTerminalEvent =>
	usage === undefined ? event : { ...event, usage };

export const createAgentRuntime = (
	options: AgentRuntimeOptions
): AgentRuntime => {
	const invocation: AgentModelInvocation = {
		providerCollection: options.providerCollection,
	};
	const run = (
		turn: AgentTurn,
		runOptions: AgentRuntimeRunOptions = {}
	): AgentTurnEventStream => {
		const policy = runOptions.modelRetry;
		if (
			policy !== undefined &&
			(!Number.isSafeInteger(policy.maxRetries) ||
				policy.maxRetries < 0 ||
				policy.maxRetries > MAX_MODEL_RETRIES ||
				!Number.isSafeInteger(policy.baseDelayMs) ||
				policy.baseDelayMs < 0 ||
				!Number.isSafeInteger(policy.maxDelayMs) ||
				policy.maxDelayMs < policy.baseDelayMs ||
				policy.maxDelayMs > MAX_MODEL_RETRY_DELAY_MS)
		) {
			throw new AgentInvariantError(
				"invalid-runtime",
				"Model retry budgets and delays must be non-negative safe integers."
			);
		}
		return runAgentTurn(turn, runOptions, invocation);
	};
	return { run };
};

type ModelStepOutput = Readonly<{
	assistantParts: readonly AgentTurnPart[];
	attemptPartialOutput?: ModelStepAttemptPartialOutput;
	completion: ProviderGenerationCompletion;
	continuation?: unknown;
	toolCalls: readonly PendingToolCall[];
	usage?: ModelUsage;
}>;

type EventEmitter = ((event: AgentTurnEvent) => AgentTurnEvent) & {
	nextSequence: () => number;
};

type ModelStepStreamOptions = Readonly<{
	emit: EventEmitter;
	invocation: AgentModelInvocation;
	request: ChatRequest;
	seenToolCallIds: Set<ToolCallId>;
	signal?: AbortSignal;
	toolsByName: ReadonlyMap<string, ResolvedTool>;
	turnId: AgentTurn["id"];
}>;

const resolveToolCall = (
	part: Extract<ChatEvent, { type: "tool-call" }>,
	toolsByName: ReadonlyMap<string, ResolvedTool>,
	seenToolCallIds: Set<ToolCallId>
): PendingToolCall => {
	if (!(isToolCallId(part.toolCallId) && isNonEmptyString(part.toolName))) {
		throw new AgentInvariantError(
			"invalid-event",
			"Provider SDK emitted a tool call without an identity.",
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

type ProviderChatUpdate =
	| Readonly<{
			completion: ProviderGenerationCompletion;
			kind: "finish";
			continuation?: unknown;
	  }>
	| Readonly<{
			kind: "part";
			part: Exclude<ChatEvent, { type: "terminal" | "usage" }>;
	  }>
	| Readonly<{ kind: "usage"; usage?: ModelUsage }>;

const createModelStepStream = (
	invocation: AgentModelInvocation,
	request: ChatRequest
): AsyncIterable<ChatEvent> => invocation.providerCollection.chat(request);

const parseProviderChatUpdate = (value: unknown): ProviderChatUpdate => {
	if (!isChatEvent(value)) {
		throw new AgentInvariantError(
			"invalid-event",
			"ProviderCollection emitted an invalid chat event.",
			{ cause: value }
		);
	}
	switch (value.type) {
		case "text-delta":
		case "reasoning-delta":
		case "tool-call":
			return { kind: "part", part: value };
		case "usage":
			return {
				kind: "usage",
				usage: normalizeModelUsage(value.usage) ?? undefined,
			};
		case "terminal":
			if (value.outcome.status === "failure") {
				throw new ProviderCollectionChatFailureError(value.outcome.failure);
			}
			if (value.outcome.status === "aborted") {
				throw new ProviderCollectionChatAbortedError();
			}
			return {
				completion: value.outcome.completion ?? { kind: "unknown" },
				kind: "finish",
				...omitUndefined({ continuation: value.outcome.continuation }),
			};
		default:
			throw new AgentInvariantError(
				"invalid-event",
				"ProviderCollection emitted an unknown chat event.",
				{ cause: value }
			);
	}
};

const outputLimitReached = (
	completion: ProviderGenerationCompletion
): true | undefined =>
	completion.kind === "incomplete" && completion.reason === "output-limit"
		? true
		: undefined;

const failureForIncompleteCompletion = (
	completion: ProviderGenerationCompletion,
	turn: AgentTurn,
	sequence: number,
	usage: ModelUsage | undefined
):
	| Extract<AgentTurnTerminalEvent, { type: "agent-turn-failed" }>
	| undefined => {
	if (
		completion.kind === "completed" ||
		(completion.kind === "incomplete" && completion.reason === "output-limit")
	) {
		return;
	}
	return {
		failure: createOperationalFailure({
			code:
				completion.kind === "incomplete" && completion.reason === "filtered"
					? "filtered"
					: "incomplete-response",
			details: getAgentTurnFailureDetails(turn),
			retry: "never",
			source: "model",
		}),
		finishedAt: Date.now(),
		sequence,
		turnId: turn.id,
		type: "agent-turn-failed",
		...omitUndefined({ usage }),
	};
};

const drainModelStep = async function* ({
	emit,
	invocation,
	request,
	seenToolCallIds,
	signal,
	toolsByName,
	turnId,
}: ModelStepStreamOptions): AsyncGenerator<
	AgentTurnEvent,
	ModelStepOutput,
	undefined
> {
	const stream = createModelStepStream(invocation, request);
	const iterator: AsyncIterator<ChatEvent> = stream[Symbol.asyncIterator]();
	const assistantParts: AgentTurnPart[] = [];
	const toolCalls: PendingToolCall[] = [];
	let bufferedText = "";
	let bufferedReasoning = "";
	let usage: ModelUsage | undefined;
	let completion: ProviderGenerationCompletion = { kind: "unknown" };
	let continuation: unknown;
	let finished = false;
	try {
		while (true) {
			const next = await awaitWithAbort(iterator.next(), signal);
			if (next.done) {
				break;
			}
			if (finished) {
				throw new AgentInvariantError(
					"invalid-event",
					"The provider stream emitted an event after its terminal outcome.",
					{ cause: next.value }
				);
			}
			const update = parseProviderChatUpdate(next.value);
			if (update.kind === "usage") {
				usage = sumUsage(usage, update.usage);
				continue;
			}
			if (update.kind === "finish") {
				finished = true;
				completion = update.completion;
				continuation = update.continuation;
				continue;
			}
			const part = update.part;
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
					bufferedReasoning += part.delta;
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
				default:
					throw new AgentInvariantError(
						"invalid-event",
						"ProviderCollection emitted an unknown chat part.",
						{ cause: part }
					);
			}
		}
	} catch (error) {
		if (error instanceof ModelStepStreamFailure) {
			throw error;
		}
		throw new ModelStepStreamFailure(
			error,
			usage,
			summarizePartialOutput(assistantParts, bufferedText, bufferedReasoning)
		);
	} finally {
		await closeModelStream(iterator);
	}
	if (!finished) {
		throw new ModelStepStreamFailure(
			new Error("Model stream ended before completion."),
			usage,
			summarizePartialOutput(assistantParts, bufferedText, bufferedReasoning)
		);
	}
	appendTextPart(assistantParts, bufferedText);
	return {
		assistantParts,
		...omitUndefined({
			attemptPartialOutput: summarizePartialOutput(
				assistantParts,
				"",
				bufferedReasoning
			),
			continuation,
			usage,
		}),
		completion,
		toolCalls,
	};
};

const MAX_MODEL_RETRIES = 10;
const MAX_MODEL_RETRY_DELAY_MS = 60_000;

const notifyRetryStatus = (
	policy: ModelRetryPolicy,
	status: ModelRetryStatus | undefined
): void => {
	try {
		policy.onStatus?.(status);
	} catch {
		// Presentation observers cannot fail or restart a model request.
	}
};

type ModelRetryDecision =
	| Readonly<{
			delayMs: number;
			failure: OperationalFailure;
			kind: "retry";
			policy: ModelRetryPolicy;
	  }>
	| Readonly<{ failure: OperationalFailure; kind: "retry-delay-exceeds-limit" }>
	| Readonly<{ failure: OperationalFailure; kind: "stopped" }>;

type ModelStepRetryOutput = Readonly<{
	attemptUsage?: ModelUsage;
	attempts: readonly ModelStepAttemptSummary[];
	output: ModelStepOutput;
}>;

type ModelStepAttemptHistory = {
	entries: ModelStepAttemptSummary[];
	truncated: boolean;
};

const appendAttemptHistory = (
	history: ModelStepAttemptHistory,
	attempts: readonly ModelStepAttemptSummary[]
): void => {
	for (const attempt of attempts) {
		if (history.entries.length === MODEL_STEP_ATTEMPT_SUMMARY_LIMIT) {
			history.truncated = true;
			return;
		}
		history.entries.push(attempt);
	}
};

const terminalEventWithAttempts = (
	event: AgentTurnTerminalEvent,
	history: ModelStepAttemptHistory
): AgentTurnTerminalEvent => ({
	...event,
	...omitUndefined({
		modelStepAttempts:
			history.entries.length === 0 ? undefined : history.entries,
		modelStepAttemptsTruncated: history.truncated ? true : undefined,
	}),
});

const modelRetryDecisionFor = ({
	attempt,
	error,
	maxRetries,
	policy,
	signal,
	turn,
}: {
	attempt: number;
	error: unknown;
	maxRetries: number;
	policy: ModelRetryPolicy | undefined;
	signal: AbortSignal | undefined;
	turn: AgentTurn;
}): ModelRetryDecision => {
	const cause = unwrapAgentRuntimeError(error);
	const failure = resolveTerminalFailure(cause, turn);
	if (
		policy === undefined ||
		attempt >= maxRetries ||
		isAgentInvariantError(cause) ||
		cause instanceof ProviderCollectionChatAbortedError ||
		signal?.aborted
	) {
		return { failure, kind: "stopped" };
	}
	const retryDelay = resolveModelRetryDelay(failure, attempt, policy);
	if (retryDelay.kind === "retry-delay-exceeds-limit") {
		return { failure, kind: "retry-delay-exceeds-limit" };
	}
	if (retryDelay.kind === "not-retryable") {
		return { failure, kind: "stopped" };
	}
	return {
		delayMs: retryDelay.delayMs,
		failure,
		kind: "retry",
		policy,
	};
};

const retryEndedEvent = (
	options: ModelStepStreamOptions & { turn: AgentTurn },
	{
		attempt,
		failure,
		maxAttempts,
		outcome,
		stepId,
	}: {
		attempt: number;
		failure: OperationalFailure | undefined;
		maxAttempts: number;
		outcome: "cancelled" | "exhausted" | "stopped" | "success";
		stepId: ModelStepId;
	}
): AgentTurnEvent =>
	options.emit({
		attempt,
		...omitUndefined({ failure }),
		maxAttempts,
		outcome,
		sequence: options.emit.nextSequence(),
		stepId,
		turnId: options.turn.id,
		type: "model-step-retry-ended",
	});

type ModelStepRetryRecovery =
	| Readonly<{ attemptUsage?: ModelUsage; kind: "retry"; retryCount: number }>
	| Readonly<{ failure: ModelStepRetryFailure; kind: "stopped" }>;

type ModelStepRetryRecoveryOptions = ModelStepStreamOptions & {
	turn: AgentTurn;
	policy: ModelRetryPolicy | undefined;
};

const retryEndOutcomeForFailure = ({
	attempt,
	cause,
	failure,
	maxRetries,
	retryCount,
	signal,
}: {
	attempt: number;
	cause: unknown;
	failure: OperationalFailure;
	maxRetries: number;
	retryCount: number;
	signal: AbortSignal | undefined;
}): "cancelled" | "exhausted" | "stopped" => {
	if (signal?.aborted) {
		return getAgentTurnAbortDisposition(signal.reason) === "cancelled"
			? "cancelled"
			: "stopped";
	}
	if (
		failure.code === "cancelled" ||
		cause instanceof ProviderCollectionChatAbortedError
	) {
		return "cancelled";
	}
	if (
		retryCount > 0 &&
		attempt >= maxRetries &&
		(failure.retry === "after-delay" || failure.retry === "immediate")
	) {
		return "exhausted";
	}
	return "stopped";
};

const modelStepAttemptSummaryForFailure = ({
	attempt,
	failure,
	maxRetries,
	partialOutput,
	retryDecision,
	stepId,
	usage,
}: {
	attempt: number;
	failure: OperationalFailure;
	maxRetries: number;
	partialOutput: ModelStepAttemptPartialOutput | undefined;
	retryDecision: "scheduled" | "stopped";
	stepId: ModelStepId;
	usage: ModelUsage | undefined;
}): ModelStepAttemptSummary => ({
	attempt,
	failure,
	maxRetries,
	...omitUndefined({ partialOutput }),
	retryDecision,
	stepId,
	...omitUndefined({ usage }),
});

const emitRetryScheduledEvent = (
	options: ModelStepRetryRecoveryOptions,
	{
		attempt,
		failure,
		maxRetries,
		partialOutput,
		retryAt,
		stepId,
		usage,
	}: {
		attempt: number;
		failure: OperationalFailure;
		maxRetries: number;
		partialOutput: ModelStepAttemptPartialOutput | undefined;
		retryAt: number;
		stepId: ModelStepId;
		usage: ModelUsage | undefined;
	}
): AgentTurnEvent =>
	options.emit({
		attempt,
		failure,
		maxAttempts: maxRetries,
		...omitUndefined({ partialOutput, usage }),
		retryAt,
		sequence: options.emit.nextSequence(),
		stepId,
		turnId: options.turn.id,
		type: "model-step-retry-scheduled",
	});

const recoverModelStepFailure = async function* (
	options: ModelStepRetryRecoveryOptions,
	{
		attempt,
		attemptUsage,
		attempts,
		maxRetries,
		retryCount,
		stepId,
		error,
	}: {
		attempt: number;
		attemptUsage: ModelUsage | undefined;
		attempts: ModelStepAttemptSummary[];
		maxRetries: number;
		retryCount: number;
		stepId: ModelStepId;
		error: unknown;
	}
): AsyncGenerator<AgentTurnEvent, ModelStepRetryRecovery, undefined> {
	const cause = unwrapAgentRuntimeError(error);
	if (isAgentInvariantError(cause)) {
		throw cause;
	}
	const decision = modelRetryDecisionFor({
		attempt,
		error: cause,
		maxRetries,
		policy: options.policy,
		signal: options.signal,
		turn: options.turn,
	});
	const streamFailure =
		error instanceof ModelStepStreamFailure ? error : undefined;
	const terminalFailure =
		decision.kind === "retry-delay-exceeds-limit"
			? createOperationalFailure({
					code: "retry-delay-exceeds-limit",
					details: decision.failure.details,
					retry: "never",
					source: "runtime",
				})
			: decision.failure;
	const attemptSummary = modelStepAttemptSummaryForFailure({
		attempt: attempt + 1,
		failure: terminalFailure,
		maxRetries,
		partialOutput: streamFailure?.partialOutput,
		retryDecision: decision.kind === "retry" ? "scheduled" : "stopped",
		stepId,
		usage: streamFailure?.usage,
	});
	attempts.push(attemptSummary);
	const nextAttemptUsage = sumUsage(attemptUsage, streamFailure?.usage);
	if (decision.kind !== "retry") {
		if (retryCount > 0) {
			yield retryEndedEvent(options, {
				attempt: retryCount,
				failure: terminalFailure,
				maxAttempts: maxRetries,
				outcome: retryEndOutcomeForFailure({
					attempt,
					cause,
					failure: terminalFailure,
					maxRetries,
					retryCount,
					signal: options.signal,
				}),
				stepId,
			});
		}
		return {
			failure: new ModelStepRetryFailure(cause, {
				attempts,
				terminalFailure,
				usage: nextAttemptUsage,
			}),
			kind: "stopped",
		};
	}
	const retryAt = Date.now() + decision.delayMs;
	const retryStatus = {
		attempt: attempt + 1,
		maxAttempts: maxRetries,
		retryAt,
	};
	yield emitRetryScheduledEvent(options, {
		attempt: retryStatus.attempt,
		failure: decision.failure,
		maxRetries,
		partialOutput: attemptSummary.partialOutput,
		retryAt: retryStatus.retryAt,
		stepId,
		usage: attemptSummary.usage,
	});
	notifyRetryStatus(decision.policy, retryStatus);
	try {
		// Bun.sleep cannot cancel its timer; abort must also release the backoff resource.
		await sleep(decision.delayMs, undefined, { signal: options.signal });
	} catch (sleepError) {
		const sleepFailure = resolveTerminalFailure(sleepError, options.turn);
		yield retryEndedEvent(options, {
			attempt: retryStatus.attempt,
			failure: sleepFailure,
			maxAttempts: maxRetries,
			outcome: retryEndOutcomeForFailure({
				attempt,
				cause: sleepError,
				failure: sleepFailure,
				maxRetries,
				retryCount: retryStatus.attempt,
				signal: options.signal,
			}),
			stepId,
		});
		return {
			failure: new ModelStepRetryFailure(sleepError, {
				attempts,
				terminalFailure: sleepFailure,
				usage: nextAttemptUsage,
			}),
			kind: "stopped",
		};
	} finally {
		notifyRetryStatus(decision.policy, undefined);
	}
	return {
		attemptUsage: nextAttemptUsage,
		kind: "retry",
		retryCount: retryStatus.attempt,
	};
};

const finishModelStepRetrySequence = async function* (
	options: ModelStepStreamOptions & { turn: AgentTurn },
	{
		attempt,
		attemptUsage,
		attempts,
		maxRetries,
		output,
		retryCount,
		stepId,
	}: {
		attempt: number;
		attemptUsage: ModelUsage | undefined;
		attempts: ModelStepAttemptSummary[];
		maxRetries: number;
		output: ModelStepOutput;
		retryCount: number;
		stepId: ModelStepId;
	}
): AsyncGenerator<AgentTurnEvent, ModelStepRetryOutput, undefined> {
	const incompleteFailure = failureForIncompleteCompletion(
		output.completion,
		options.turn,
		0,
		output.usage
	);
	if (incompleteFailure !== undefined) {
		attempts.push({
			attempt: attempt + 1,
			failure: incompleteFailure.failure,
			maxRetries,
			...omitUndefined({ partialOutput: output.attemptPartialOutput }),
			retryDecision: "stopped",
			stepId,
			...omitUndefined({ usage: output.usage }),
		});
	}
	if (retryCount > 0) {
		yield retryEndedEvent(options, {
			attempt: retryCount,
			failure: incompleteFailure?.failure,
			maxAttempts: maxRetries,
			outcome: incompleteFailure === undefined ? "success" : "stopped",
			stepId,
		});
	}
	return { attempts, output, ...omitUndefined({ attemptUsage }) };
};

const abortModelStepRetrySequence = async function* (
	options: ModelStepStreamOptions & { turn: AgentTurn },
	{
		attempts,
		attemptUsage,
		maxRetries,
		retryCount,
	}: {
		attempts: ModelStepAttemptSummary[];
		attemptUsage: ModelUsage | undefined;
		maxRetries: number;
		retryCount: number;
	}
): AsyncGenerator<AgentTurnEvent, never, undefined> {
	const abortError = createAbortError(options.signal?.reason);
	const terminalFailure = resolveTerminalFailure(abortError, options.turn);
	if (retryCount === 0) {
		throw abortError;
	}
	const lastAttempt = attempts.at(-1);
	if (lastAttempt !== undefined) {
		yield retryEndedEvent(options, {
			attempt: retryCount,
			failure: terminalFailure,
			maxAttempts: maxRetries,
			outcome: "cancelled",
			stepId: lastAttempt.stepId,
		});
	}
	throw new ModelStepRetryFailure(abortError, {
		attempts,
		terminalFailure,
		usage: attemptUsage,
	});
};

const drainModelStepWithRetry = async function* (
	options: ModelStepStreamOptions & {
		turn: AgentTurn;
		policy: ModelRetryPolicy | undefined;
		remainingRequests: number;
		onRequest: () => ModelStepId;
		modelStepObserver: AgentRuntimeRunOptions["modelStepObserver"];
	}
): AsyncGenerator<AgentTurnEvent, ModelStepRetryOutput, undefined> {
	const { policy, turn } = options;
	const maxRetries = Math.min(
		policy?.maxRetries ?? 0,
		options.remainingRequests - 1
	);
	const attempts: ModelStepAttemptSummary[] = [];
	let attemptUsage: ModelUsage | undefined;
	let retryCount = 0;
	for (let attempt = 0; ; attempt += 1) {
		if (options.signal?.aborted) {
			yield* abortModelStepRetrySequence(options, {
				attempts,
				attemptUsage,
				maxRetries,
				retryCount,
			});
		}
		const stepId = options.onRequest();
		yield options.emit({
			modelId: turn.model.modelId,
			sequence: options.emit.nextSequence(),
			stepId,
			turnId: turn.id,
			type: "model-step-started",
		});
		notifyModelStepStarted(options.modelStepObserver, options.request);
		try {
			const attemptToolCallIds = new Set(options.seenToolCallIds);
			const output = yield* drainModelStep({
				...options,
				seenToolCallIds: attemptToolCallIds,
			});
			for (const toolCallId of attemptToolCallIds) {
				options.seenToolCallIds.add(toolCallId);
			}
			return yield* finishModelStepRetrySequence(options, {
				attempt,
				attemptUsage,
				attempts,
				maxRetries,
				output,
				retryCount,
				stepId,
			});
		} catch (error) {
			const recovery = yield* recoverModelStepFailure(options, {
				attempt,
				attemptUsage,
				attempts,
				maxRetries,
				retryCount,
				stepId,
				error,
			});
			if (recovery.kind === "stopped") {
				throw recovery.failure;
			}
			retryCount = recovery.retryCount;
			attemptUsage = recovery.attemptUsage;
		}
	}
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
	{ messages: readonly ChatMessage[]; stopTurn: boolean },
	undefined
> {
	const exclusive =
		calls.length > 1 &&
		calls.find((call) => call.tool.definition.exclusiveInBatch === true);
	const outcomes = await awaitWithAbort(
		exclusive
			? Promise.resolve(
					calls.map(
						(): ToolCallOutput => ({
							errorText: `${exclusive.tool.definition.name} must be the only Tool Call in this Model Step; no Tool Calls in the batch ran.`,
							type: "failure",
						})
					)
				)
			: Promise.all(
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
	const messages: ChatMessage[] = [];
	let stopTurn = false;
	for (const [index, call] of calls.entries()) {
		const outcome = outcomes[index];
		if (isUndefined(outcome)) {
			throw new AgentInvariantError(
				"invalid-runtime",
				"Tool execution did not produce an outcome.",
				{ cause: call }
			);
		}
		stopTurn ||= outcome.type === "success" && outcome.stopTurn === true;
		const publicOutcome =
			outcome.type === "success" && outcome.stopTurn === true
				? { output: outcome.output, type: "success" as const }
				: outcome;
		yield emit({
			outcome: publicOutcome,
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
	return { messages, stopTurn };
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
	attemptHistory: ModelStepAttemptHistory;
	cacheWarming?: true;
	emit: EventEmitter;
	maximumModelSteps?: AgentRuntimeRunOptions["maximumModelSteps"];
	modelStepObserver?: AgentRuntimeRunOptions["modelStepObserver"];
	modelRetry?: ModelRetryPolicy;
	prepareNextStep?: AgentRuntimeRunOptions["prepareNextStep"];
	invocation: AgentModelInvocation;
	modelMessages: ChatMessage[];
	promptCacheKey?: string;
	runtimeSignal?: AbortSignal;
	takeSteeringMessages?: AgentRuntimeRunOptions["takeSteeringMessages"];
	tools: readonly ResolvedTool[];
	toolsByName: ReadonlyMap<string, ResolvedTool>;
	turn: AgentTurn;
}>;

type BuildChatRequestOptions = Readonly<{
	cacheWarming?: true;
	modelMessages: ChatMessage[];
	promptCacheKey?: string;
	runtimeSignal?: AbortSignal;
	toolDefinitions: ChatTool[];
	turn: AgentTurn;
}>;

const buildChatRequest = ({
	cacheWarming,
	modelMessages,
	promptCacheKey,
	runtimeSignal,
	toolDefinitions,
	turn,
}: BuildChatRequestOptions): ChatRequest => ({
	messages: [...modelMessages],
	modelId: turn.model.modelId,
	providerId: turn.model.providerId,
	...omitUndefined({
		cacheRetention:
			turn.model.promptCacheEnabled === true
				? turn.model.promptCacheRetention
				: undefined,
		cacheWarming,
		maxOutputTokens: turn.model.maxOutputTokens,
		promptCacheKey,
		reasoningEffort: turn.model.thinkingLevel,
		signal: runtimeSignal,
		system: turn.agent.instructions,
		tools: toolDefinitions,
	}),
});

const appendAssistantOutput = (
	modelMessages: ChatMessage[],
	output: ModelStepOutput
): void => {
	modelMessages.push({
		...omitUndefined({ continuation: output.continuation }),
		content: output.assistantParts,
		role: "assistant",
	});
};

const appendSteeringMessages = (
	modelMessages: ChatMessage[],
	output: ModelStepOutput,
	messages: readonly AgentTurnMessage[]
): void => {
	if (output.toolCalls.length === 0) {
		appendAssistantOutput(modelMessages, output);
	}
	modelMessages.push(...messages.map(modelPromptMessage));
};
const appendLateSteeringMessages = async (
	modelMessages: ChatMessage[],
	output: ModelStepOutput,
	assistantOutputAlreadyAppended: boolean,
	takeSteeringMessages: AgentRuntimeRunOptions["takeSteeringMessages"]
): Promise<boolean> => {
	const messages = (await takeSteeringMessages?.()) ?? [];
	if (messages.length === 0) {
		return false;
	}
	if (!assistantOutputAlreadyAppended) {
		appendAssistantOutput(modelMessages, output);
	}
	modelMessages.push(...messages.map(modelPromptMessage));
	return true;
};

const notifyModelStepStarted = (
	observer: AgentRuntimeRunOptions["modelStepObserver"],
	request: ChatRequest
): void => {
	try {
		observer?.onModelStepStarted(request);
	} catch {
		// A best-effort request observer cannot fail an active Agent Turn.
	}
};

const notifyModelStepFinished = (
	observer: AgentRuntimeRunOptions["modelStepObserver"],
	request: ChatRequest,
	usage: ModelUsage | undefined
): void => {
	try {
		observer?.onModelStepFinished(request, usage);
	} catch {
		// A best-effort usage observer cannot fail an active Agent Turn.
	}
};

const prepareModelStepHistory = async (
	options: BuildChatRequestOptions & {
		output: ModelStepOutput;
		prepareNextStep: NonNullable<AgentRuntimeRunOptions["prepareNextStep"]>;
		protectedFromIndex: number;
		takeSteeringMessages: AgentRuntimeRunOptions["takeSteeringMessages"];
	}
): Promise<void> => {
	const { modelMessages, protectedFromIndex, runtimeSignal } = options;
	const prepared = await options.prepareNextStep({
		protectedFromIndex,
		request: buildChatRequest({
			...options,
			modelMessages: [...modelMessages],
		}),
	});
	if (runtimeSignal?.aborted) {
		return;
	}
	if (prepared !== undefined) {
		modelMessages.splice(
			0,
			protectedFromIndex,
			...prepared.map(modelPromptMessage)
		);
	}
	// Preparation can await a Provider; steering committed meanwhile joins this request once.
	await appendLateSteeringMessages(
		modelMessages,
		options.output,
		true,
		options.takeSteeringMessages
	);
};

type ProcessModelStepOutputOptions = BuildChatRequestOptions &
	Readonly<{
		emit: EventEmitter;
		modelStepObserver?: AgentRuntimeRunOptions["modelStepObserver"];
		output: ModelStepOutput;
		attemptHistory: ModelStepAttemptHistory;
		prepareNextStep?: AgentRuntimeRunOptions["prepareNextStep"];
		protectedFromIndex: number;
		request: ChatRequest;
		stepId: ModelStepId;
		takeSteeringMessages?: AgentRuntimeRunOptions["takeSteeringMessages"];
		totalUsage: ModelUsage | undefined;
	}>;

type ProcessModelStepOutputResult = Readonly<{
	continueTurn: boolean;
	totalUsage: ModelUsage | undefined;
}>;

const processModelStepOutput = async function* ({
	cacheWarming,
	emit,
	modelMessages,
	modelStepObserver,
	output,
	attemptHistory,
	prepareNextStep,
	protectedFromIndex,
	promptCacheKey,
	request,
	runtimeSignal,
	stepId,
	takeSteeringMessages,
	toolDefinitions,
	totalUsage,
	turn,
}: ProcessModelStepOutputOptions): AsyncGenerator<
	AgentTurnEvent,
	ProcessModelStepOutputResult,
	undefined
> {
	notifyModelStepFinished(modelStepObserver, request, output.usage);
	let stopTurn = false;
	if (output.toolCalls.length > 0) {
		modelMessages.push({
			...omitUndefined({ continuation: output.continuation }),
			content: output.assistantParts,
			role: "assistant",
		});
		const execution = yield* executeToolCalls({
			calls: output.toolCalls,
			emit,
			...omitUndefined({ signal: runtimeSignal }),
			turnId: turn.id,
		});
		modelMessages.push(...execution.messages);
		stopTurn = execution.stopTurn;
	}
	yield emit({
		modelId: turn.model.modelId,
		sequence: emit.nextSequence(),
		stepId,
		turnId: turn.id,
		type: "model-step-finished",
		...omitUndefined({ usage: output.usage }),
	});
	const nextTotalUsage = sumUsage(totalUsage, output.usage);
	if (stopTurn) {
		yield emit(
			terminalEventWithAttempts(
				{
					finishedAt: Date.now(),
					sequence: emit.nextSequence(),
					turnId: turn.id,
					type: "agent-turn-completed",
					...omitUndefined({ usage: nextTotalUsage }),
				},
				attemptHistory
			)
		);
		return { continueTurn: false, totalUsage: nextTotalUsage };
	}
	const steeringMessages = await takeSteeringMessages?.();
	const hasSteeringMessages =
		steeringMessages !== undefined && steeringMessages.length > 0;
	if (hasSteeringMessages) {
		appendSteeringMessages(modelMessages, output, steeringMessages ?? []);
	}
	const additionalMessagesDelivered = await appendLateSteeringMessages(
		modelMessages,
		output,
		output.toolCalls.length > 0 || hasSteeringMessages,
		takeSteeringMessages
	);
	if (
		output.toolCalls.length === 0 &&
		!hasSteeringMessages &&
		!additionalMessagesDelivered
	) {
		yield emit(
			terminalEventWithAttempts(
				{
					finishedAt: Date.now(),
					sequence: emit.nextSequence(),
					turnId: turn.id,
					type: "agent-turn-completed",
					...omitUndefined({
						outputLimitReached: outputLimitReached(output.completion),
						usage: nextTotalUsage,
					}),
				},
				attemptHistory
			)
		);
		return { continueTurn: false, totalUsage: nextTotalUsage };
	}
	if (prepareNextStep !== undefined) {
		await prepareModelStepHistory({
			cacheWarming,
			modelMessages,
			output,
			prepareNextStep,
			protectedFromIndex,
			promptCacheKey,
			runtimeSignal,
			takeSteeringMessages,
			toolDefinitions,
			turn,
		});
	}
	return { continueTurn: true, totalUsage: nextTotalUsage };
};

const hasReachedModelStepLimit = (
	maximumModelSteps: number | undefined,
	requestCount: number
): boolean =>
	maximumModelSteps !== undefined && requestCount >= maximumModelSteps;

const toAgentRuntimeExecutionFailure = (
	error: unknown,
	totalUsage: ModelUsage | undefined,
	attemptHistory: ModelStepAttemptHistory
): Error => {
	const cause = unwrapAgentRuntimeError(error);
	if (isAgentInvariantError(cause)) {
		return cause;
	}
	if (!(error instanceof ModelStepRetryFailure)) {
		return new AgentRuntimeExecutionFailure(cause, totalUsage);
	}
	appendAttemptHistory(attemptHistory, error.attempts);
	return new AgentRuntimeExecutionFailure(
		error,
		sumUsage(totalUsage, error.usage)
	);
};

const runLoop = async function* ({
	attemptHistory,
	cacheWarming,
	emit,
	maximumModelSteps,
	invocation,
	modelMessages,
	modelStepObserver,
	modelRetry,
	prepareNextStep,
	promptCacheKey,
	runtimeSignal,
	takeSteeringMessages,
	tools,
	toolsByName,
	turn,
}: ExecuteModelStepsOptions): AsyncGenerator<AgentTurnEvent, void, undefined> {
	let totalUsage: ModelUsage | undefined;
	const seenToolCallIds = new Set<ToolCallId>();
	const toolDefinitions = tools.map(toModelTool);
	let requestCount = 0;
	try {
		while (true) {
			if (runtimeSignal?.aborted) {
				yield emit(
					terminalEventWithAttempts(
						terminalEventWithUsage(
							createAgentTurnAbortEvent(
								turn,
								runtimeSignal,
								emit.nextSequence()
							),
							totalUsage
						),
						attemptHistory
					)
				);
				return;
			}
			if (hasReachedModelStepLimit(maximumModelSteps, requestCount)) {
				yield emit(
					terminalEventWithAttempts(
						{
							failure: createOperationalFailure({
								code: "model-step-limit",
								details: getAgentTurnFailureDetails(turn),
								retry: "never",
								source: "runtime",
							}),
							finishedAt: Date.now(),
							sequence: emit.nextSequence(),
							turnId: turn.id,
							type: "agent-turn-failed",
							...omitUndefined({ usage: totalUsage }),
						},
						attemptHistory
					)
				);
				return;
			}
			const protectedFromIndex = modelMessages.length;
			let stepId = toModelStepId(`step-${requestCount + 1}`);
			const request = buildChatRequest({
				cacheWarming,
				modelMessages,
				promptCacheKey,
				runtimeSignal,
				toolDefinitions,
				turn,
			});
			const retryResult = yield* drainModelStepWithRetry({
				policy: cacheWarming ? undefined : modelRetry,
				remainingRequests:
					(maximumModelSteps ?? Number.POSITIVE_INFINITY) - requestCount,
				modelStepObserver,
				onRequest: () => {
					requestCount += 1;
					stepId = toModelStepId(`step-${requestCount}`);
					return stepId;
				},
				turn,
				emit,
				invocation,
				request,
				seenToolCallIds,
				...omitUndefined({ signal: runtimeSignal }),
				toolsByName,
				turnId: turn.id,
			});
			appendAttemptHistory(attemptHistory, retryResult.attempts);
			totalUsage = sumUsage(totalUsage, retryResult.attemptUsage);
			const output = retryResult.output;
			const incompleteFailure = failureForIncompleteCompletion(
				output.completion,
				turn,
				emit.nextSequence(),
				sumUsage(totalUsage, output.usage)
			);
			if (incompleteFailure !== undefined) {
				yield emit(
					terminalEventWithAttempts(incompleteFailure, attemptHistory)
				);
				return;
			}
			const stepResult = yield* processModelStepOutput({
				attemptHistory,
				cacheWarming,
				emit,
				modelMessages,
				modelStepObserver,
				output,
				prepareNextStep,
				protectedFromIndex,
				promptCacheKey,
				request,
				runtimeSignal,
				stepId,
				takeSteeringMessages,
				toolDefinitions,
				totalUsage,
				turn,
			});
			totalUsage = stepResult.totalUsage;
			if (!stepResult.continueTurn) {
				return;
			}
		}
	} catch (error) {
		throw toAgentRuntimeExecutionFailure(error, totalUsage, attemptHistory);
	}
};

const runAgentTurn = async function* (
	turn: AgentTurn,
	{
		cacheWarming,
		deadlineMs,
		maximumModelSteps,
		modelStepObserver,
		modelRetry,
		prepareNextStep,
		promptCacheKey,
		signal,
		takeSteeringMessages,
	}: AgentRuntimeRunOptions,
	invocation: AgentModelInvocation
): AsyncGenerator<AgentTurnEvent, void, undefined> {
	const lifecycle = createAgentTurnLifecycle(turn.id);
	const runtimeSignalLease = resolveRuntimeSignal(signal, deadlineMs);
	const runtimeSignal = runtimeSignalLease.signal;
	const tools = turn.tools ?? [];
	const toolsByName = createToolsByName(tools);
	const modelMessages = turn.input.messages.map(modelPromptMessage);
	const attemptHistory: ModelStepAttemptHistory = {
		entries: [],
		truncated: false,
	};
	const emit: EventEmitter = Object.assign(
		(event: AgentTurnEvent) => {
			lifecycle.apply(event);
			return event;
		},
		{ nextSequence: () => lifecycle.getState().lastSequence + 1 }
	);
	try {
		yield emit({
			agentId: turn.agent.id,
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
			yield* runLoop({
				attemptHistory,
				emit,
				invocation,
				modelMessages,
				...omitUndefined({
					cacheWarming,
					maximumModelSteps,
					modelStepObserver,
					modelRetry,
					prepareNextStep,
					promptCacheKey,
					runtimeSignal,
					takeSteeringMessages,
				}),
				tools,
				toolsByName,
				turn,
			});
		} catch (error) {
			const executionFailure =
				error instanceof AgentRuntimeExecutionFailure ? error : undefined;
			const cause = executionFailure?.cause ?? error;
			const underlyingCause = unwrapAgentRuntimeError(cause);
			if (isAgentInvariantError(underlyingCause)) {
				throw underlyingCause;
			}
			if (runtimeSignal?.aborted) {
				yield emit(
					terminalEventWithAttempts(
						terminalEventWithUsage(
							createAgentTurnAbortEvent(
								turn,
								runtimeSignal,
								emit.nextSequence()
							),
							executionFailure?.usage
						),
						attemptHistory
					)
				);
				return;
			}
			if (underlyingCause instanceof ProviderCollectionChatAbortedError) {
				yield terminalEventWithAttempts(
					terminalEventWithUsage(
						lifecycle.cancel(emit.nextSequence()),
						executionFailure?.usage
					),
					attemptHistory
				);
				return;
			}
			yield emit(
				terminalEventWithAttempts(
					toAgentTurnTerminalEvent(
						turn,
						cause,
						emit.nextSequence(),
						executionFailure?.usage
					),
					attemptHistory
				)
			);
		}
	} finally {
		runtimeSignalLease.dispose();
	}
};

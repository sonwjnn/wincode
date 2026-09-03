import type { ModelMessage } from "@ai-sdk/provider-utils";
import type {
	AgentRuntime,
	AgentRuntimeRunOptions,
	AgentTurn,
	AgentTurnEvent,
	AgentTurnEventStream,
	ModelStepId,
	OperationalFailure,
} from "@wincode/agent-core";
import { OPERATIONAL_FAILURE_VERSION } from "@wincode/agent-core";
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

/**
 * Maps an expected model failure to the safe, versioned Agent Turn failure
 * contract. The normalized model failure taxonomy supplies stable codes,
 * presentation-safe messages, and retry dispositions; raw causes, credentials,
 * prompts, headers, and provider bodies never reach the public shape.
 */
const resolveTerminalFailure = (
	error: unknown,
	turn: AgentTurn
): OperationalFailure => {
	if (isAbortLike(error)) {
		// Cancellation the caller did not cause is turn-machinery behavior,
		// not a model verdict: it carries the runtime source. Caller aborts
		// never reach here — the run gates on the caller's signal instead and
		// yields no terminal event.
		return {
			code: "cancelled",
			details: {
				modelId: turn.model.modelId,
				providerId: turn.model.providerId,
			},
			message: "The Agent Turn was cancelled.",
			retry: "never",
			source: "runtime",
			version: OPERATIONAL_FAILURE_VERSION,
		};
	}
	const modelFailure: ModelFailure = normalizeModelFailure(error, {
		modelId: turn.model.modelId,
		providerId: turn.model.providerId,
	});
	return {
		code: modelFailure.code,
		details: {
			modelId: modelFailure.details?.modelId,
			...(modelFailure.details?.providerId
				? { providerId: modelFailure.details.providerId }
				: {}),
			...(modelFailure.details?.retryAfterMs
				? { retryAfterMs: modelFailure.details.retryAfterMs }
				: {}),
		},
		message: modelFailure.message,
		retry: modelFailure.retry,
		source: "model",
		version: OPERATIONAL_FAILURE_VERSION,
	};
};

const toModelUsage = (usage: unknown): ModelUsage | undefined =>
	normalizeModelUsage(usage) ?? undefined;

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
	{ signal }: AgentRuntimeRunOptions,
	resolveModel: ResolveAgentModel
): AsyncGenerator<AgentTurnEvent, void, undefined> {
	const { agent, model, input } = turn;
	const resolved = resolveModel(model);
	const modelMessages: ModelMessage[] = input.messages.map((message) => ({
		content: message.parts.map((part) => ({
			text: part.text,
			type: "text",
		})),
		role: message.role,
	}));

	const agentLoop = new ToolLoopAgent<never, ToolSet>({
		activeTools: [],
		instructions: agent.instructions,
		maxOutputTokens: resolved.maxOutputTokens,
		model: resolved.model,
		providerOptions: resolved.providerOptions,
		stopWhen: stepCountIs(1),
		tools: noToolSet,
	});

	let sequence = 0;
	let stepIndex = 0;
	let stepId: ModelStepId | undefined;

	yield {
		agentId: agent.id,
		sequence: sequence++,
		startedAt: Date.now(),
		turnId: turn.id,
		type: "agent-turn-started",
	};

	try {
		const result = await agentLoop.stream({
			abortSignal: signal,
			prompt: modelMessages,
		});

		for await (const part of result.fullStream) {
			if (signal?.aborted) {
				return;
			}
			switch (part.type) {
				case "start-step": {
					stepIndex += 1;
					stepId = `${STEP_ID_PREFIX}-${stepIndex}`;
					yield {
						modelId: resolved.modelId,
						sequence: sequence++,
						stepId,
						turnId: turn.id,
						type: "model-step-started",
					};
					break;
				}
				case "text-start":
				case "text-end":
				case "reasoning-start":
				case "reasoning-end": {
					break;
				}
				case "text-delta": {
					yield {
						delta: part.text,
						sequence: sequence++,
						turnId: turn.id,
						type: "text-delta",
					};
					break;
				}
				case "reasoning-delta": {
					yield {
						delta: part.text,
						sequence: sequence++,
						turnId: turn.id,
						type: "reasoning-delta",
					};
					break;
				}
				case "finish-step": {
					yield {
						modelId: resolved.modelId,
						sequence: sequence++,
						stepId: stepId ?? `${STEP_ID_PREFIX}-1`,
						turnId: turn.id,
						type: "model-step-finished",
						usage: toModelUsage(part.usage),
					};
					break;
				}
				case "finish": {
					yield {
						finishedAt: Date.now(),
						sequence: sequence++,
						turnId: turn.id,
						type: "agent-turn-completed",
						usage: toModelUsage(part.totalUsage),
					};
					return;
				}
				case "error": {
					yield {
						failure: resolveTerminalFailure(part.error, turn),
						finishedAt: Date.now(),
						sequence: sequence++,
						turnId: turn.id,
						type: "agent-turn-failed",
					};
					return;
				}
				case "abort": {
					return;
				}
				default: {
					// Tool, file, source, and raw parts never appear in a text-only
					// turn; ignore anything unexpected instead of leaking it.
					break;
				}
			}
		}
	} catch (error) {
		// Only the caller's own abort ends a run without a terminal event.
		// An AbortError the SDK raised on its own (provider or step-controller
		// initiated) is a genuine failure and must surface as one.
		if (signal?.aborted) {
			return;
		}
		yield {
			failure: resolveTerminalFailure(error, turn),
			finishedAt: Date.now(),
			sequence: sequence++,
			turnId: turn.id,
			type: "agent-turn-failed",
		};
	}
};

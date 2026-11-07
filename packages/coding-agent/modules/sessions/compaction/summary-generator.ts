import { setTimeout as sleep } from "node:timers/promises";
import {
	createOperationalFailure,
	type ModelStepId,
	type OperationalFailure,
	resolveModelRetryDelay,
	toModelStepId,
} from "@wincode/agent-core";
import type {
	ChatEvent,
	ChatOutcome,
	ModelFailure,
	ProviderCollection,
	ProviderModel,
} from "@wincode/ai";
import { normalizeModelFailure, normalizeModelUsage } from "@wincode/ai";
import { isPositiveSafeInteger, omitUndefined } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import {
	isAvailableProviderModelSelection,
	type ProviderModelSelection,
	providerModelReasoningEffort,
} from "@/modules/providers/provider-model-selection";
import type { SessionCompactionRetryEvent } from "../session-events";
import {
	COMPACTION_SUMMARY_SYSTEM_PROMPT,
	resolvePreparedSummaryRequest,
	SUMMARY_REQUEST_SAFETY_MARGIN_TOKENS,
} from "./summary-prompt";
import {
	MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
	type PreparedSummaryRequest,
	type SummaryGenerator,
	type SummaryGeneratorInput,
	type SummaryGeneratorResult,
} from "./types";

const providerModelFor = (
	collection: ProviderCollection,
	selection: ProviderModelSelection
): ProviderModel | undefined =>
	collection.getModel(selection.providerId, selection.modelId);

const isAvailableProviderModel = async (
	collection: ProviderCollection,
	selection: ProviderModelSelection
): Promise<boolean> =>
	isAvailableProviderModelSelection(
		selection,
		await collection.getAvailable(selection.providerId)
	);

const unavailableSummaryModel = (selection: ProviderModelSelection): string =>
	`Provider Model ${selection.providerId}/${selection.modelId} is unavailable. Choose another model to compact this session.`;

const notInvocableSummaryModel = (selection: ProviderModelSelection): string =>
	`Provider Model ${selection.providerId}/${selection.modelId} is not invocable. Connect its Provider or choose another model.`;

/**
 * Resolves the exact invocable summary model. Output-cap support is not an
 * availability requirement: subscription routes may omit the cap.
 */
export const resolveInvocableSummaryModel = async (
	collection: ProviderCollection,
	selection: ProviderModelSelection
): Promise<
	{ failure: string; model?: never } | { failure?: never; model: ProviderModel }
> => {
	const model = providerModelFor(collection, selection);
	if (model === undefined) {
		return { failure: unavailableSummaryModel(selection) };
	}
	if (!(await isAvailableProviderModel(collection, selection))) {
		return { failure: notInvocableSummaryModel(selection) };
	}
	return { model };
};

export const requireInvocableProviderModel = async (
	collection: ProviderCollection,
	selection: ProviderModelSelection
): Promise<ProviderModel> => {
	const model = providerModelFor(collection, selection);
	if (model === undefined) {
		throw new Error(unavailableSummaryModel(selection));
	}
	if (!(await isAvailableProviderModel(collection, selection))) {
		throw new Error(notInvocableSummaryModel(selection));
	}
	return model;
};

class ProviderSummaryFailure extends Error {
	readonly failure: ModelFailure;

	constructor(failure: ModelFailure) {
		super(failure.message);
		this.name = "ProviderSummaryFailure";
		this.failure = failure;
	}
}

export class CompactionSummaryGenerationFailure extends Error {
	readonly failure: OperationalFailure;

	constructor(failure: OperationalFailure) {
		super(failure.message);
		this.name = "CompactionSummaryGenerationFailure";
		this.failure = failure;
	}
}

const modelFailureContext = (selection: ProviderModelSelection) => ({
	modelId: selection.modelId,
	providerId: selection.providerId,
});

const operationalFailureFor = (
	failure: ModelFailure,
	selection: ProviderModelSelection
): OperationalFailure =>
	createOperationalFailure({
		code: failure.code,
		details: omitUndefined({
			modelId: failure.details?.modelId ?? selection.modelId,
			providerId: failure.details?.providerId ?? selection.providerId,
			retryAfterMs: failure.details?.retryAfterMs,
			statusCode: failure.details?.statusCode,
		}),
		retry: failure.retry,
		source: failure.source === "runtime" ? "runtime" : "model",
	});

const emitCompactionEvent = (
	callback: ((event: SessionCompactionRetryEvent) => void) | undefined,
	event: SessionCompactionRetryEvent
): void => {
	try {
		callback?.(event);
	} catch {
		// Session observers cannot change compaction behavior.
	}
};

const throwForProviderSummaryTerminal = (
	outcome: ChatOutcome,
	selection: ProviderModelSelection,
	signal: AbortSignal | undefined
): void => {
	if (outcome.status === "failure") {
		throw new ProviderSummaryFailure(
			normalizeModelFailure(outcome.failure, modelFailureContext(selection))
		);
	}
	if (outcome.status === "aborted") {
		throw signal?.reason ?? new DOMException("Aborted", "AbortError");
	}
	if (outcome.status === "success" && outcome.completion.kind !== "completed") {
		throw new CompactionSummaryGenerationFailure(
			createOperationalFailure({
				code: "incomplete-response",
				retry: "never",
				source: "model",
			})
		);
	}
};

const collectProviderSummary = async (
	events: AsyncIterable<ChatEvent>,
	selection: ProviderModelSelection,
	signal: AbortSignal | undefined,
	reportUsage: SummaryGeneratorInput["reportUsage"]
): Promise<SummaryGeneratorResult> => {
	let text = "";
	let usage: SummaryGeneratorResult["usage"];
	let terminalSeen = false;
	let generationFailed = false;
	let generationError: unknown;
	try {
		for await (const event of events) {
			switch (event.type) {
				case "text-delta":
					text += event.delta;
					break;
				case "usage":
					usage = normalizeModelUsage(event.usage) ?? undefined;
					break;
				case "terminal":
					terminalSeen = true;
					throwForProviderSummaryTerminal(event.outcome, selection, signal);
					break;
				default:
					break;
			}
		}
	} catch (error) {
		generationFailed = true;
		generationError = error;
	}
	if (!(generationFailed || terminalSeen)) {
		generationFailed = true;
		generationError = new CompactionSummaryGenerationFailure(
			createOperationalFailure({
				code: "incomplete-response",
				retry: "never",
				source: "model",
			})
		);
	}
	if (generationFailed && usage !== undefined) {
		try {
			await reportUsage?.(usage);
		} catch (usageError) {
			throw new AggregateError(
				[generationError, usageError],
				"Provider generation failed and its usage could not be persisted."
			);
		}
	}
	if (generationFailed) {
		if (
			generationError instanceof ProviderSummaryFailure ||
			generationError instanceof CompactionSummaryGenerationFailure
		) {
			throw generationError;
		}
		throw new ProviderSummaryFailure(
			normalizeModelFailure(generationError, modelFailureContext(selection))
		);
	}
	return { text, ...omitUndefined({ usage }) };
};

type ResolvedProviderSummaryRequest = Readonly<{
	canEnforceOutputLimit: boolean;
	model: ProviderModel;
	preparedRequest: PreparedSummaryRequest;
}>;

const resolveProviderSummaryRequest = async (
	collection: ProviderCollection,
	input: SummaryGeneratorInput
): Promise<ResolvedProviderSummaryRequest> => {
	const model = await requireInvocableProviderModel(
		collection,
		input.target.model
	);
	const canEnforceOutputLimit = await collection.canEnforceMaxOutputTokens(
		model.providerId,
		model.modelId
	);
	const preparedRequest = resolvePreparedSummaryRequest(input);
	const contextWindowTokens = input.target.contextWindowTokens;
	if (!isPositiveSafeInteger(input.target.outputCeilingTokens)) {
		throw new Error(
			`Cannot verify the summary output ceiling for Provider Model ${model.providerId}/${model.modelId}: the resolved target limit is invalid.`
		);
	}
	if (!isPositiveSafeInteger(contextWindowTokens)) {
		throw new Error(
			`Cannot verify that the summary request fits Provider Model ${model.providerId}/${model.modelId}: the configured context-window limit is invalid.`
		);
	}
	const contextOutputBudget =
		contextWindowTokens -
		preparedRequest.estimatedInputTokens -
		SUMMARY_REQUEST_SAFETY_MARGIN_TOKENS;
	if (contextOutputBudget < MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS) {
		throw new Error(
			`The summary prompt is estimated at ${preparedRequest.estimatedInputTokens} tokens; only ${Math.max(0, contextOutputBudget)} output tokens remain in the effective Wincode context window of ${contextWindowTokens}, below the ${MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS}-token minimum.`
		);
	}
	const targetOutputLimit = Math.floor(
		Math.min(input.target.outputCeilingTokens, contextOutputBudget)
	);
	if (targetOutputLimit < MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS) {
		throw new Error(
			`The selected Provider Model can provide only ${targetOutputLimit} summary output tokens, below the minimum of ${MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS} required for a viable handoff.`
		);
	}
	if (
		!isPositiveSafeInteger(input.maxOutputTokens) ||
		input.maxOutputTokens < MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS
	) {
		throw new Error(
			`The planned summary request must allow at least ${MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS} output tokens.`
		);
	}
	if (input.maxOutputTokens > targetOutputLimit) {
		throw new Error(
			`The planned summary output allowance of ${input.maxOutputTokens} tokens exceeds the resolved target or request context limit of ${targetOutputLimit} tokens.`
		);
	}
	return { canEnforceOutputLimit, model, preparedRequest };
};

type SummaryRetryDecision =
	| Readonly<{ kind: "retry"; retryCount: number }>
	| Readonly<{ kind: "stop" }>;

type SummaryRetryOutcome = "cancelled" | "exhausted" | "stopped" | "success";

const emitSummaryRetryEnded = (
	input: SummaryGeneratorInput,
	model: ProviderModel,
	attempt: number,
	maxRetries: number,
	stepId: ModelStepId,
	outcome: SummaryRetryOutcome,
	failure?: OperationalFailure
): void => {
	const retryContext = input.retryContext;
	if (attempt === 0 || retryContext === undefined) {
		return;
	}
	emitCompactionEvent(retryContext.onEvent, {
		attempt,
		compactionId: retryContext.compactionId,
		...(failure === undefined ? {} : { failure }),
		maxRetries,
		modelId: model.modelId,
		outcome,
		providerId: model.providerId,
		sessionId: retryContext.sessionId,
		stepId,
		type: "compaction-summary-retry-ended",
	});
};

const failureForSummary = (
	error: unknown,
	selection: ProviderModelSelection
): OperationalFailure => {
	if (error instanceof CompactionSummaryGenerationFailure) {
		return error.failure;
	}
	const modelFailure =
		error instanceof ProviderSummaryFailure
			? error.failure
			: normalizeModelFailure(error, modelFailureContext(selection));
	return operationalFailureFor(modelFailure, selection);
};

const summaryRetryOutcomeFor = (
	failure: OperationalFailure
): "exhausted" | "stopped" =>
	failure.source === "model" &&
	(failure.retry === "after-delay" || failure.retry === "immediate")
		? "exhausted"
		: "stopped";

const waitForSummaryRetry = async (
	input: SummaryGeneratorInput,
	model: ProviderModel,
	attempt: number,
	maxRetries: number,
	stepId: ModelStepId,
	delayMs: number
): Promise<void> => {
	try {
		await sleep(delayMs, undefined, { signal: input.signal });
	} catch (sleepError) {
		const cancelled = input.signal?.aborted === true;
		emitSummaryRetryEnded(
			input,
			model,
			attempt,
			maxRetries,
			stepId,
			cancelled ? "cancelled" : "stopped",
			createOperationalFailure({
				code: cancelled ? "cancelled" : "unknown",
				retry: "never",
				source: "runtime",
			})
		);
		throw sleepError;
	}
};

const handleSummaryGenerationFailure = async (input: {
	attemptStarted: boolean;
	error: unknown;
	failure: OperationalFailure;
	input: SummaryGeneratorInput;
	lastStepId: ModelStepId | undefined;
	model: ProviderModel;
	retryCount: number;
	stepId: ModelStepId;
}): Promise<SummaryRetryDecision> => {
	const {
		attemptStarted,
		error,
		failure,
		input: generatorInput,
		lastStepId,
		model,
		retryCount,
		stepId,
	} = input;
	const maxRetries = generatorInput.retryPolicy?.maxRetries ?? 0;
	const terminalStepId = lastStepId ?? stepId;
	if (generatorInput.signal?.aborted) {
		emitSummaryRetryEnded(
			generatorInput,
			model,
			retryCount,
			maxRetries,
			terminalStepId,
			"cancelled",
			createOperationalFailure({
				code: "cancelled",
				retry: "never",
				source: "runtime",
			})
		);
		throw error;
	}
	const retryPolicy = generatorInput.retryPolicy;
	const retryDelay =
		retryPolicy === undefined || retryCount >= maxRetries
			? { kind: "not-retryable" as const }
			: resolveModelRetryDelay(failure, retryCount, retryPolicy);
	if (retryDelay.kind === "retry-delay-exceeds-limit") {
		const stoppedFailure = createOperationalFailure({
			code: "retry-delay-exceeds-limit",
			details: failure.details,
			retry: "never",
			source: "runtime",
		});
		emitSummaryRetryEnded(
			generatorInput,
			model,
			retryCount,
			maxRetries,
			terminalStepId,
			"stopped",
			stoppedFailure
		);
		throw new CompactionSummaryGenerationFailure(stoppedFailure);
	}
	if (retryDelay.kind === "not-retryable") {
		if (retryCount > 0) {
			emitSummaryRetryEnded(
				generatorInput,
				model,
				retryCount,
				maxRetries,
				terminalStepId,
				summaryRetryOutcomeFor(failure),
				failure
			);
		}
		return { kind: "stop" };
	}
	const attempt = retryCount + 1;
	const retryAt = Date.now() + retryDelay.delayMs;
	const retryContext = generatorInput.retryContext;
	if (retryContext !== undefined && attemptStarted) {
		emitCompactionEvent(retryContext.onEvent, {
			attempt,
			compactionId: retryContext.compactionId,
			failure,
			maxRetries,
			modelId: model.modelId,
			providerId: model.providerId,
			retryAt,
			sessionId: retryContext.sessionId,
			stepId,
			type: "compaction-summary-retry-scheduled",
		});
	}
	await waitForSummaryRetry(
		generatorInput,
		model,
		attempt,
		maxRetries,
		stepId,
		retryDelay.delayMs
	);
	return { kind: "retry", retryCount: attempt };
};

const runProviderSummaryWithRetries = async (
	collection: ProviderCollection,
	input: SummaryGeneratorInput,
	request: ResolvedProviderSummaryRequest,
	assertTrustedSelection?: (model: ProviderModelSelection) => void
): Promise<SummaryGeneratorResult> => {
	const { canEnforceOutputLimit, model, preparedRequest } = request;
	const maxRetries = input.retryPolicy?.maxRetries ?? 0;
	let retryCount = 0;
	let lastStepId: ModelStepId | undefined;
	for (;;) {
		const stepId = toModelStepId(randomUUIDv7());
		let attemptStarted = false;
		try {
			assertTrustedSelection?.(input.target.model);
			attemptStarted = true;
			lastStepId = stepId;
			const retryContext = input.retryContext;
			if (retryContext !== undefined) {
				emitCompactionEvent(retryContext.onEvent, {
					attempt: retryCount + 1,
					compactionId: retryContext.compactionId,
					maxRetries,
					modelId: model.modelId,
					providerId: model.providerId,
					sessionId: retryContext.sessionId,
					stepId,
					type: "compaction-summary-attempt-started",
				});
			}
			const events = collection.chat({
				// Subscription routes may reject output caps. Omit unsupported caps and
				// let the caller require explicit completion before accepting the handoff.
				...omitUndefined({
					maxOutputTokens: canEnforceOutputLimit
						? input.maxOutputTokens
						: undefined,
				}),
				messages: [
					{
						content: [{ text: preparedRequest.prompt, type: "text" }],
						role: "user",
					},
				],
				modelId: model.modelId,
				providerId: model.providerId,
				...omitUndefined({
					reasoningEffort: providerModelReasoningEffort(
						model,
						input.target.thinkingLevel
					),
					signal: input.signal,
				}),
				system: COMPACTION_SUMMARY_SYSTEM_PROMPT,
			});
			const result = await collectProviderSummary(
				events,
				input.target.model,
				input.signal,
				input.reportUsage
			);
			emitSummaryRetryEnded(
				input,
				model,
				retryCount,
				maxRetries,
				stepId,
				"success"
			);
			return result;
		} catch (error) {
			const failure = failureForSummary(error, input.target.model);
			const decision = await handleSummaryGenerationFailure({
				attemptStarted,
				error,
				failure,
				input,
				lastStepId,
				model,
				retryCount,
				stepId,
			});
			if (decision.kind === "retry") {
				retryCount = decision.retryCount;
				continue;
			}
			if (error instanceof CompactionSummaryGenerationFailure) {
				throw error;
			}
			throw new CompactionSummaryGenerationFailure(failure);
		}
	}
};

const providerSummaryGenerator =
	(
		collection: ProviderCollection,
		assertTrustedSelection?: (model: ProviderModelSelection) => void
	): SummaryGenerator =>
	async (input) => {
		const request = await resolveProviderSummaryRequest(collection, input);
		return runProviderSummaryWithRetries(
			collection,
			input,
			request,
			assertTrustedSelection
		);
	};
/** Uses only an explicitly invocable SDK Provider Model without changing its stored identity. */
export const createProviderSummaryGenerator = (
	collection: ProviderCollection,
	assertTrustedSelection?: (model: ProviderModelSelection) => void
): SummaryGenerator =>
	providerSummaryGenerator(collection, assertTrustedSelection);

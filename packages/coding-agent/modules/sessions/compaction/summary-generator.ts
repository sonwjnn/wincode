import type {
	ChatEvent,
	ChatOutcome,
	ProviderCollection,
	ProviderModel,
} from "@wincode/ai";
import { normalizeModelUsage } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
import {
	isAvailableProviderModelSelection,
	type ProviderModelSelection,
	providerModelReasoningEffort,
} from "@/modules/providers/provider-model-selection";
import {
	COMPACTION_SUMMARY_SYSTEM_PROMPT,
	resolvePreparedSummaryRequest,
	SUMMARY_REQUEST_SAFETY_MARGIN_TOKENS,
} from "./summary-prompt";
import {
	DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
	MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS,
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

const outputCapabilityGuidance = (model: ProviderModel): string =>
	model.providerId === "openai"
		? "OpenAI OAuth cannot enforce the required output-token limit. Connect with an API key or explicitly configure compaction.summary.model with a capable Provider Model."
		: "This Provider credential cannot enforce the required output-token limit. Configure compaction.summary.model with a capable Provider Model.";

/**
 * Resolves whether a summary model can actually generate one. A caller that
 * may not need generation (a Plugin can supply the handoff) receives the
 * failure as data instead of an exception, so it can defer it.
 */
export const resolveSummaryModelCapability = async (
	collection: ProviderCollection,
	selection: ProviderModelSelection
): Promise<
	| { deferrable: boolean; failure: string; model?: never }
	| { failure?: never; model: ProviderModel }
> => {
	const model = providerModelFor(collection, selection);
	if (model === undefined) {
		return { deferrable: false, failure: unavailableSummaryModel(selection) };
	}
	if (!(await isAvailableProviderModel(collection, selection))) {
		return { deferrable: false, failure: notInvocableSummaryModel(selection) };
	}
	if (
		!(await collection.canEnforceMaxOutputTokens(
			model.providerId,
			model.modelId
		))
	) {
		// Only this credential capability can be replaced by a Plugin handoff.
		return {
			deferrable: true,
			failure: `Compaction is unavailable for Provider Model ${model.providerId}/${model.modelId}. ${outputCapabilityGuidance(model)}`,
		};
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

const throwForProviderSummaryTerminal = (
	outcome: ChatOutcome,
	selection: ProviderModelSelection,
	signal: AbortSignal | undefined
): void => {
	if (outcome.status === "failure") {
		throw new Error(
			`Provider Model ${selection.providerId}/${selection.modelId} failed: ${outcome.failure.code}.`
		);
	}
	if (outcome.status === "aborted") {
		throw signal?.reason ?? new DOMException("Aborted", "AbortError");
	}
	if (outcome.status === "success" && outcome.completion.kind !== "completed") {
		const reason =
			outcome.completion.kind === "incomplete"
				? outcome.completion.reason
				: "unknown";
		throw new Error(
			`Summary generation from Provider Model ${selection.providerId}/${selection.modelId} did not complete (${reason}); refusing partial output.`
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
		throw generationError;
	}
	return { text, ...omitUndefined({ usage }) };
};

export const requireSummaryOutputCapability = async (
	collection: ProviderCollection,
	model: ProviderModel
): Promise<void> => {
	if (
		await collection.canEnforceMaxOutputTokens(model.providerId, model.modelId)
	) {
		return;
	}
	throw new Error(
		`Compaction is unavailable for Provider Model ${model.providerId}/${model.modelId}. ${outputCapabilityGuidance(model)}`
	);
};

const providerSummaryGenerator =
	(collection: ProviderCollection): SummaryGenerator =>
	async (input) => {
		const model = await requireInvocableProviderModel(collection, input.model);
		await requireSummaryOutputCapability(collection, model);
		const preparedRequest = resolvePreparedSummaryRequest(input);
		const contextWindowTokens = model.limits?.contextWindowTokens;
		if (
			contextWindowTokens === undefined ||
			!Number.isSafeInteger(contextWindowTokens) ||
			contextWindowTokens <= 0
		) {
			throw new Error(
				`Cannot verify that the summary request fits Provider Model ${model.providerId}/${model.modelId}: its context-window limit is unavailable.`
			);
		}
		const contextOutputBudget =
			contextWindowTokens -
			preparedRequest.estimatedInputTokens -
			SUMMARY_REQUEST_SAFETY_MARGIN_TOKENS;
		if (contextOutputBudget < MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS) {
			throw new Error(
				`The summary prompt is estimated at ${preparedRequest.estimatedInputTokens} tokens; only ${Math.max(0, contextOutputBudget)} output tokens remain in the Provider Model context window of ${contextWindowTokens}, below the ${MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS}-token minimum.`
			);
		}
		const maxOutputTokens = Math.floor(
			Math.min(
				Math.max(
					1,
					Math.floor(
						input.maxOutputTokens ?? DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS
					)
				),
				model.limits?.maxOutputTokens ?? Number.MAX_SAFE_INTEGER,
				contextOutputBudget
			)
		);
		if (maxOutputTokens < MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS) {
			throw new Error(
				`The selected Provider Model can provide only ${maxOutputTokens} summary output tokens, below the minimum of ${MIN_COMPACTION_SUMMARY_OUTPUT_TOKENS} required for a viable handoff.`
			);
		}
		const events = collection.chat({
			maxOutputTokens,
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
					input.thinkingLevel
				),
				signal: input.signal,
			}),
			system: COMPACTION_SUMMARY_SYSTEM_PROMPT,
		});
		return collectProviderSummary(
			events,
			input.model,
			input.signal,
			input.reportUsage
		);
	};

/** Uses only an explicitly invocable SDK Provider Model without changing its stored identity. */
export const createProviderSummaryGenerator = (
	collection: ProviderCollection,
	assertTrustedSelection?: (model: ProviderModelSelection) => void
): SummaryGenerator => {
	const generateSummary = providerSummaryGenerator(collection);
	return (input) => {
		assertTrustedSelection?.(input.model);
		return generateSummary(input);
	};
};

import { type ModelUsage, modelUsageSchema } from "@wincode/ai";
import { isNonEmptyString, isPlainObject } from "@wincode/utils";
import type { UnknownRecord } from "type-fest";
import { isOperationalFailure, type OperationalFailure } from "./failures";
import type { ModelId, ModelStepId } from "./identifiers";

export type { ModelStepId } from "./identifiers";

/**
 * One model invocation inside an Agent Turn. A text-only turn runs a single
 * Model Step; tool-armed turns run one per tool round trip. Deltas streamed
 * inside a step are transient Agent Turn Events, never durable records.
 */
export type ModelStep = Readonly<{
	finishedAt?: number;
	id: ModelStepId;
	/** Zero-based position of this step within its Agent Turn. */
	index: number;
	modelId?: ModelId;
	startedAt: number;
	usage?: ModelUsage;
}>;

export const MODEL_STEP_ATTEMPT_SUMMARY_LIMIT = 32;
export const MODEL_STEP_ATTEMPT_CONTENT_LIMIT = 4096;
export const MODEL_STEP_RETRY_END_OUTCOMES = [
	"cancelled",
	"exhausted",
	"stopped",
	"success",
] as const;

export type ModelStepAttemptPartialOutput = Readonly<{
	reasoning?: string;
	text?: string;
	truncated?: true;
}>;

/** A bounded, non-replayable summary of one failed Model request attempt. */
export type ModelStepAttemptSummary = Readonly<{
	/** One-based request attempt within the retry sequence. */
	attempt: number;
	failure: OperationalFailure;
	maxRetries: number;
	partialOutput?: ModelStepAttemptPartialOutput;
	retryDecision: "scheduled" | "stopped";
	stepId: ModelStepId;
	usage?: ModelUsage;
}>;

export type ModelStepRetryEndOutcome =
	(typeof MODEL_STEP_RETRY_END_OUTCOMES)[number];

export const isModelStepRetryEndOutcome = (
	value: unknown
): value is ModelStepRetryEndOutcome =>
	typeof value === "string" &&
	(MODEL_STEP_RETRY_END_OUTCOMES as readonly string[]).includes(value);

export const isModelStepAttemptPartialOutput = (
	value: unknown
): value is ModelStepAttemptPartialOutput => {
	if (!isPlainObject(value)) {
		return false;
	}
	const partial = value as UnknownRecord;
	return (
		Object.keys(partial).every((key) =>
			["reasoning", "text", "truncated"].includes(key)
		) &&
		(partial.reasoning === undefined ||
			(isNonEmptyString(partial.reasoning) &&
				partial.reasoning.length <= MODEL_STEP_ATTEMPT_CONTENT_LIMIT)) &&
		(partial.text === undefined ||
			(isNonEmptyString(partial.text) &&
				partial.text.length <= MODEL_STEP_ATTEMPT_CONTENT_LIMIT)) &&
		(partial.truncated === undefined || partial.truncated === true) &&
		(partial.reasoning !== undefined ||
			partial.text !== undefined ||
			partial.truncated === true)
	);
};

export const isModelStepAttemptSummary = (
	value: unknown
): value is ModelStepAttemptSummary => {
	if (!isPlainObject(value)) {
		return false;
	}
	const summary = value as UnknownRecord;
	if (
		Object.keys(summary).some(
			(key) =>
				![
					"attempt",
					"failure",
					"maxRetries",
					"partialOutput",
					"retryDecision",
					"stepId",
					"usage",
				].includes(key)
		) ||
		!Number.isSafeInteger(summary.attempt) ||
		Number(summary.attempt) < 1 ||
		!Number.isSafeInteger(summary.maxRetries) ||
		Number(summary.maxRetries) < 0 ||
		Number(summary.attempt) > Number(summary.maxRetries) + 1 ||
		!isOperationalFailure(summary.failure) ||
		!isNonEmptyString(summary.stepId) ||
		!(
			summary.retryDecision === "scheduled" ||
			summary.retryDecision === "stopped"
		) ||
		(summary.usage !== undefined &&
			!modelUsageSchema.safeParse(summary.usage).success)
	) {
		return false;
	}
	return (
		summary.partialOutput === undefined ||
		isModelStepAttemptPartialOutput(summary.partialOutput)
	);
};

import type { ModelUsage } from "@wincode/ai/model-usage";

/** Opaque identity of one Model Step (one model invocation). */
export type ModelStepId = string;

/**
 * One model invocation inside an Agent Turn. A text-only turn runs a single
 * Model Step; tool-armed turns run one per tool round trip. Deltas streamed
 * inside a step are transient Agent Turn Events, never durable records.
 */
export type ModelStep = {
	readonly finishedAt?: number;
	readonly id: ModelStepId;
	/** Zero-based position of this step within its Agent Turn. */
	readonly index: number;
	readonly modelId?: string;
	readonly startedAt: number;
	readonly usage?: ModelUsage;
};

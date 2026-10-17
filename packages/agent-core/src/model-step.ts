import type { ModelUsage } from "@wincode/ai";
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

import { omitUndefined } from "@wincode/utils";
import { z } from "zod";
import {
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";

/** Trusted summary routing policy, separate from conversation retention policy. */
export type CompactionSummarySettings = Readonly<{
	model?: ProviderModelSelection;
	maxOutputTokens?: number;
	/** Invalid explicit policy must fail compaction rather than select a fallback. */
	error?: string;
}>;

const summarySettingsSchema = z
	.object({
		model: z.string().optional(),
		maxOutputTokens: z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.optional(),
	})
	.strict();

export const resolveCompactionSummarySettings = (
	value: unknown,
	path: readonly string[]
): CompactionSummarySettings => {
	if (value === undefined) {
		return {};
	}
	const parsed = summarySettingsSchema.safeParse(value);
	if (!parsed.success) {
		return {
			error: `Invalid ${path.join(".")}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}. Correct the summary configuration before compacting.`,
		};
	}
	const model =
		parsed.data.model === undefined
			? undefined
			: parseProviderModelSelection(parsed.data.model);
	if (model === null) {
		return {
			error: `Invalid ${[...path, "model"].join(".")}: expected an exact provider/model identity. Correct the summary configuration before compacting.`,
		};
	}
	return {
		...omitUndefined({
			model,
			maxOutputTokens: parsed.data.maxOutputTokens,
		}),
	};
};

import type { ThinkingLevel } from "../model-metadata.ts";

const EFFORT_ALIASES: Readonly<Record<string, ThinkingLevel | undefined>> = {
	minimal: "low",
	medium: "high",
	xhigh: "high",
};

const ALIAS_MODEL_IDS: ReadonlySet<string> = new Set([
	"deepseek-flash",
	"deepseek-v4-pro",
]);

/** Converts documented DeepSeek-only effort aliases for the named models. */
export const deepSeekEffortAliasFor = (
	providerId: string | undefined,
	modelId: string | undefined,
	effort: string
): ThinkingLevel | undefined => {
	if (
		providerId !== "deepseek" ||
		modelId === undefined ||
		!ALIAS_MODEL_IDS.has(modelId)
	) {
		return;
	}
	return EFFORT_ALIASES[effort];
};

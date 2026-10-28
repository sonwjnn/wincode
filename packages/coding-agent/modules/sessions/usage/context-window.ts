import { isPositiveSafeInteger, isUndefined } from "@wincode/utils";
import type { ConfigSnapshot } from "@/shared/config/config-store";

/** Fallback context capacity used when the selected model publishes no valid limit. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 272_000;

export type ContextWindowResolution = Readonly<{
	invalid: boolean;
	overrideTokens?: number;
	tokens: number;
}>;

/** Uses an explicit settings override, then model metadata, then the fallback. */
export const resolveContextWindowTokens = (
	snapshot: ConfigSnapshot | undefined,
	modelContextWindowTokens?: number | null,
	configuredOverride?: number
): ContextWindowResolution => {
	const configured = isUndefined(configuredOverride)
		? snapshot?.document.contextWindowTokens
		: configuredOverride;
	const modelLimit = isPositiveSafeInteger(modelContextWindowTokens)
		? modelContextWindowTokens
		: DEFAULT_CONTEXT_WINDOW_TOKENS;
	if (isUndefined(configured)) {
		return { invalid: false, tokens: modelLimit };
	}
	if (isPositiveSafeInteger(configured)) {
		return {
			invalid: false,
			overrideTokens: configured,
			tokens: configured,
		};
	}
	return { invalid: true, tokens: modelLimit };
};

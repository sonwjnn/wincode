import { isPositiveSafeInteger, isUndefined } from "@wincode/utils";
import type { ConfigSnapshot } from "@/shared/config/config-store";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 272_000;

export type ContextWindowResolution = Readonly<{
	invalid: boolean;
	tokens: number;
}>;

/** Reads the merged project/global override, falling back to Wincode's default. */
export const resolveContextWindowTokens = (
	snapshot: ConfigSnapshot | undefined
): ContextWindowResolution => {
	const value = snapshot?.document.contextWindowTokens;
	if (isUndefined(value)) {
		return { invalid: false, tokens: DEFAULT_CONTEXT_WINDOW_TOKENS };
	}
	if (isPositiveSafeInteger(value)) {
		return { invalid: false, tokens: value };
	}
	return { invalid: true, tokens: DEFAULT_CONTEXT_WINDOW_TOKENS };
};

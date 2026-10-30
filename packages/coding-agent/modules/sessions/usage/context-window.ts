import {
	isPlainObject,
	isPositiveSafeInteger,
	isUndefined,
} from "@wincode/utils";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type { ConfigSnapshot } from "@/shared/config/config-store";

/** Fallback context capacity used when the selected model publishes no valid limit. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 272_000;

export type ContextWindowResolution = Readonly<{
	invalid: boolean;
	/** Explicit global override, also used for summary targets. */
	overrideTokens?: number;
	/** Exact conversation-model override, scoped to that model. */
	modelOverrideTokens?: number;
	modelOverrideInvalid: boolean;
	modelOverridePath?: readonly string[];
	tokens: number;
}>;

type ModelContextWindowOverride = Readonly<{
	invalid: boolean;
	path?: readonly string[];
	tokens?: number;
}>;

const contextWindowOverrideForModel = (
	snapshot: ConfigSnapshot | undefined,
	model: ProviderModelSelection | undefined
): ModelContextWindowOverride => {
	if (snapshot === undefined || model === undefined) {
		return { invalid: false };
	}
	const configPath = isUndefined(snapshot.document.compaction)
		? []
		: ["compaction"];
	const rawConfig = isUndefined(snapshot.document.compaction)
		? snapshot.document
		: snapshot.document.compaction;
	if (!(isPlainObject(rawConfig) && isPlainObject(rawConfig.modelOverrides))) {
		return { invalid: false };
	}
	const identity = `${model.providerId}/${model.modelId}`;
	const modelOverride = rawConfig.modelOverrides[identity];
	if (
		!(
			isPlainObject(modelOverride) &&
			Object.hasOwn(modelOverride, "contextWindowTokens")
		)
	) {
		return { invalid: false };
	}
	const path = [
		...configPath,
		"modelOverrides",
		identity,
		"contextWindowTokens",
	];
	const contextWindowTokens = modelOverride.contextWindowTokens;
	return isPositiveSafeInteger(contextWindowTokens)
		? { invalid: false, path, tokens: contextWindowTokens }
		: { invalid: true, path };
};

/** Uses explicit overrides, model metadata, then the fallback. */
export const resolveContextWindowTokens = (
	snapshot: ConfigSnapshot | undefined,
	modelContextWindowTokens?: number | null,
	configuredOverride?: number,
	model?: ProviderModelSelection
): ContextWindowResolution => {
	const modelOverride = contextWindowOverrideForModel(snapshot, model);
	const configured = isUndefined(configuredOverride)
		? snapshot?.document.contextWindowTokens
		: configuredOverride;
	const globalOverride = isPositiveSafeInteger(configured)
		? configured
		: undefined;
	const modelLimit = isPositiveSafeInteger(modelContextWindowTokens)
		? modelContextWindowTokens
		: DEFAULT_CONTEXT_WINDOW_TOKENS;
	return {
		invalid: !isUndefined(configured) && globalOverride === undefined,
		...(globalOverride === undefined ? {} : { overrideTokens: globalOverride }),
		...(modelOverride.tokens === undefined
			? {}
			: { modelOverrideTokens: modelOverride.tokens }),
		modelOverrideInvalid: modelOverride.invalid,
		...(modelOverride.path === undefined
			? {}
			: { modelOverridePath: modelOverride.path }),
		tokens: modelOverride.tokens ?? globalOverride ?? modelLimit,
	};
};

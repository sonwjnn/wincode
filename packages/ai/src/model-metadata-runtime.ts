import { isUndefined } from "@wincode/utils";
// Read path over the generated model metadata snapshot. Kept separate from
// ./catalog so the catalog stays a compile-time constant that cannot depend on
// generated output, and so removal of the snapshot never breaks selection.

import {
	type ChatModelSelection,
	findSupportedChatModelSelection,
	type SupportedChatModel,
	supportsSelectableReasoning,
} from "./catalog";
import { modelMetadataByKey } from "./generated/model-metadata.generated";
import type {
	ModelMetadataEntry,
	ModelThinkingPolicy,
	ThinkingLevel,
	ThinkingLevelMap,
	ThinkingSelection,
} from "./model-metadata";
import { thinkingLevelIds, thinkingLevelSchema } from "./model-metadata";

export { modelMetadataSnapshotDate } from "./generated/model-metadata.generated";

const DEFAULT_THINKING_LEVEL_VALUES: Readonly<
	Partial<Record<ThinkingLevel, string>>
> = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
};

export const getModelMetadata = (
	model: SupportedChatModel | null
): ModelMetadataEntry | undefined =>
	model ? modelMetadataByKey[`${model.provider}/${model.id}`] : undefined;

const createThinkingLadderMap = (
	policy: ModelThinkingPolicy
): ThinkingLevelMap => {
	const map: Partial<Record<ThinkingLevel, string | null>> = {
		off: policy.toggle ? "off" : null,
	};
	for (const level of thinkingLevelIds) {
		if (level === "off") {
			continue;
		}
		map[level] = policy.levels?.includes(level) ? level : null;
	}
	return map;
};

const createToggleThinkingMap = (): ThinkingLevelMap => {
	const map: Partial<Record<ThinkingLevel, string | null>> = { off: "off" };
	for (const level of thinkingLevelIds) {
		if (level !== "off") {
			map[level] = "thinking";
		}
	}
	return map;
};

const getModelThinkingLevelMap = (
	policy: ModelThinkingPolicy | undefined
): ThinkingLevelMap | undefined => {
	if (!policy || policy.unlevelled) {
		return;
	}
	let map: ThinkingLevelMap | undefined;
	if (policy.levels?.length) {
		map = createThinkingLadderMap(policy);
	} else if (policy.toggle) {
		map = createToggleThinkingMap();
	}
	if (policy.levelMap !== undefined) {
		return { ...map, ...policy.levelMap };
	}
	return map;
};

/**
 * Resolves a model's native value for one unified level. A missing standard
 * level uses the provider default; xhigh and max require explicit opt-in.
 */
export const getModelThinkingLevelValue = (
	model: SupportedChatModel | null,
	thinkingLevel: ThinkingLevel
): string | undefined => {
	if (!(model && supportsSelectableReasoning(model))) {
		return;
	}
	const policy = getModelMetadata(model)?.thinking;
	const levelMap = getModelThinkingLevelMap(policy);
	if (!levelMap) {
		return;
	}
	const mapped = levelMap[thinkingLevel];
	if (mapped === null) {
		return;
	}
	return mapped ?? DEFAULT_THINKING_LEVEL_VALUES[thinkingLevel];
};

/** The unified levels a model can express through its per-model map. */
const getSupportedThinkingLevelsForModel = (
	model: SupportedChatModel | null
): readonly ThinkingLevel[] =>
	thinkingLevelIds.filter(
		(level) => !isUndefined(getModelThinkingLevelValue(model, level))
	);

export const getSupportedThinkingLevels = (
	selection: ChatModelSelection
): readonly ThinkingLevel[] =>
	getSupportedThinkingLevelsForModel(
		findSupportedChatModelSelection(selection)
	);

export const isSupportedThinkingLevel = (
	selection: ChatModelSelection,
	thinkingLevel: ThinkingLevel
): boolean => getSupportedThinkingLevels(selection).includes(thinkingLevel);

export const normalizeThinkingLevel = (
	selection: ChatModelSelection,
	thinkingLevel: string | undefined
): ThinkingLevel | undefined =>
	normalizeThinkingLevelForModel(
		findSupportedChatModelSelection(selection),
		thinkingLevel
	);

export const normalizeThinkingLevelForModel = (
	model: SupportedChatModel | null,
	thinkingLevel: string | undefined
): ThinkingLevel | undefined => {
	if (isUndefined(thinkingLevel)) {
		return;
	}
	const parsed = thinkingLevelSchema.safeParse(thinkingLevel);
	return parsed.success &&
		getSupportedThinkingLevelsForModel(model).includes(parsed.data)
		? parsed.data
		: undefined;
};

/** Normalizes one unified Thinking Level for the selected model. */
export const normalizeThinkingSelection = (
	selection: ChatModelSelection,
	choice: ThinkingSelection
): ThinkingSelection => {
	if (isUndefined(choice.thinkingLevel)) {
		return {};
	}
	const thinkingLevel = normalizeThinkingLevel(selection, choice.thinkingLevel);
	return thinkingLevel === undefined ? {} : { thinkingLevel };
};

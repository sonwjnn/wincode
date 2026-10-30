// Combines manifest-declared Provider Models with upstream metadata facts.
// Family overlays and Wincode policies are applied as distinct catalog stages.

import type { ModelMetadataEntry } from "../src/model-metadata";
import { metadataForModel } from "../src/models-dev";
import { modelsDevBlocksFromPayload } from "../src/models-dev-payload";
import { withProviderModelMetadata } from "../src/provider-model-metadata.ts";
import type { ProviderModel } from "../src/sdk.ts";
import type { ProviderModelFamilyId } from "./model-families/types.ts";
import { applyWincodeContextWindowPolicy } from "./model-policies/context-window.ts";

export type BuildInput = Readonly<{
	/** Exact-identity classifications used only by Wincode's catalog policies. */
	modelFamilies: ReadonlyMap<string, ProviderModelFamilyId>;
	overlays: Readonly<Record<string, ModelMetadataEntry>>;
	payload: unknown;
	providerModels: readonly ProviderModel[];
}>;

export type BuildResult = Readonly<{
	entries: Readonly<Record<string, ModelMetadataEntry>>;
	providerModels: readonly ProviderModel[];
	coverage: Readonly<{
		absentUpstream: readonly string[];
		fromOverlay: readonly string[];
		fromSource: number;
		providerModelCount: number;
		uncovered: readonly string[];
	}>;
}>;

const mergeModelMetadata = (
	source: ModelMetadataEntry | undefined,
	overlay: ModelMetadataEntry | undefined
): ModelMetadataEntry => {
	const sourceThinking = source?.thinking;
	const overlayThinking = overlay?.thinking;
	let thinking: ModelMetadataEntry["thinking"];
	if (sourceThinking === undefined) {
		thinking = overlayThinking;
	} else if (overlayThinking === undefined) {
		thinking = sourceThinking;
	} else {
		const levels =
			sourceThinking.levels === undefined &&
			overlayThinking.levels === undefined
				? undefined
				: [
						...new Set([
							...(sourceThinking.levels ?? []),
							...(overlayThinking.levels ?? []),
						]),
					];
		const levelMap =
			sourceThinking.levelMap === undefined &&
			overlayThinking.levelMap === undefined
				? undefined
				: {
						...sourceThinking.levelMap,
						...overlayThinking.levelMap,
					};
		thinking = {
			...sourceThinking,
			...overlayThinking,
			...(levels === undefined ? {} : { levels }),
			...(levelMap === undefined ? {} : { levelMap }),
		};
	}
	return {
		...source,
		...overlay,
		...(thinking === undefined ? {} : { thinking }),
	};
};

/** Enriches only manifest-declared Provider Models; metadata never adds identity. */
export const buildProviderModelsWithMetadata = (
	input: BuildInput
): BuildResult => {
	const blocks = modelsDevBlocksFromPayload(input.payload);
	const entries: Record<string, ModelMetadataEntry> = {};
	const absentUpstream: string[] = [];
	const uncovered: string[] = [];
	const fromOverlay: string[] = [];
	let fromSource = 0;

	const providerModels = input.providerModels.map((model) => {
		const key = `${model.providerId}/${model.modelId}`;
		const upstream = blocks.get(model.providerId)?.get(model.modelId);
		const overlay = input.overlays[key];
		const sourceMetadata = upstream
			? metadataForModel(upstream, model)
			: undefined;
		const upstreamMetadata =
			sourceMetadata && Object.keys(sourceMetadata).length > 0
				? sourceMetadata
				: undefined;
		if (upstreamMetadata) {
			fromSource += 1;
		} else {
			absentUpstream.push(key);
			if (!overlay) {
				uncovered.push(key);
			}
		}
		if (overlay) {
			fromOverlay.push(key);
		}
		const metadata = mergeModelMetadata(upstreamMetadata, overlay);
		entries[key] = metadata;
		return applyWincodeContextWindowPolicy(
			withProviderModelMetadata(model, metadata),
			input.modelFamilies.get(key)
		);
	});

	return {
		entries,
		providerModels,
		coverage: {
			absentUpstream,
			fromOverlay,
			fromSource,
			providerModelCount: input.providerModels.length,
			uncovered,
		},
	};
};

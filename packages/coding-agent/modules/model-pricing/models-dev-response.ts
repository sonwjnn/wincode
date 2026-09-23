import { modelRuntimeProviderIds } from "@wincode/ai/models";
import {
	convertModelsDevPayload,
	type ModelMetadataEntry,
} from "@wincode/ai/models-dev";
import { type ModelPricingTable, modelPricingKey } from "./model-pricing";

const runtimeProviderIds: Readonly<Record<string, true>> = Object.fromEntries(
	modelRuntimeProviderIds.map((providerId) => [providerId, true as const])
);
const isModelRuntimeProviderId = (
	value: string
): value is (typeof modelRuntimeProviderIds)[number] =>
	runtimeProviderIds[value] === true;

/**
 * Runtime refresh over `https://models.dev/api.json`. Shares its converter
 * with the offline generator (`@wincode/ai/models-dev`), so a fetched table
 * and the committed snapshot can only ever differ in *how current* they are,
 * never in how a field is interpreted. See ADR-0014.
 *
 * Only the runtime providers Wincode routes to are kept — models.dev also
 * lists ~170 resellers whose prices do not apply here — and a row with no
 * recognized metadata is dropped rather than given a default.
 */
export const buildModelPricingTable = (
	raw: unknown,
	ids: ReadonlySet<string>
): ModelPricingTable => {
	const table: Record<string, ModelMetadataEntry> = {};
	for (const [key, metadata] of convertModelsDevPayload(raw)) {
		const separator = key.indexOf("/");
		const provider = key.slice(0, separator);
		const modelId = key.slice(separator + 1);
		if (
			isModelRuntimeProviderId(provider) &&
			ids.has(modelId) &&
			Object.keys(metadata).length > 0
		) {
			table[modelPricingKey(provider, modelId)] = metadata;
		}
	}
	return table;
};

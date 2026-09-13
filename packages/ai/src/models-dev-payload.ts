// Structural parsing for the remote models.dev payload. This module is shared
// by the runtime converter and the offline generator and must not import any
// generated snapshot.

import { z } from "zod";

/** One models.dev model record, untyped because the payload is remote. */
export type ModelsDevModel = Record<string, unknown>;

const payloadSchema = z.record(z.string(), z.unknown());
const providerBlockSchema = z
	.object({ models: z.record(z.string(), z.unknown()) })
	.passthrough();
const modelSchema = z.record(z.string(), z.unknown());

/**
 * Extracts provider/model blocks from a models.dev payload. Invalid provider or
 * model values are ignored; metadata interpretation belongs to `models-dev.ts`.
 */
export const modelsDevBlocksFromPayload = (
	payload: unknown
): ReadonlyMap<string, ReadonlyMap<string, ModelsDevModel>> => {
	const blocks = new Map<string, Map<string, ModelsDevModel>>();
	const parsedPayload = payloadSchema.safeParse(payload);
	if (!parsedPayload.success) {
		return blocks;
	}
	for (const [providerId, block] of Object.entries(parsedPayload.data)) {
		const parsedBlock = providerBlockSchema.safeParse(block);
		if (!parsedBlock.success) {
			continue;
		}
		const entries = new Map<string, ModelsDevModel>();
		for (const [modelId, model] of Object.entries(parsedBlock.data.models)) {
			const parsedModel = modelSchema.safeParse(model);
			if (parsedModel.success) {
				entries.set(modelId, parsedModel.data);
			}
		}
		blocks.set(providerId, entries);
	}
	return blocks;
};

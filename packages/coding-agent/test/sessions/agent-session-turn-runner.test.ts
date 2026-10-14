import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { toModelId } from "@wincode/agent-core";
import type { ProviderCollection, ProviderModel } from "@wincode/ai/sdk";
import { resolveSessionTurnModel } from "@/modules/sessions/host/agent-session-turn-runner";

test("SDK model output maxima remain metadata instead of implicit Agent request budgets", async () => {
	const providerModel: ProviderModel = {
		limits: { maxOutputTokens: 128 },
		modelId: "gpt-5.6",
		protocolId: "openai-responses",
		providerId: "openai",
	};
	const providerCollection = fromPartial<ProviderCollection>({
		getAvailable: async () => [providerModel],
		getModel: () => providerModel,
	});

	const model = await resolveSessionTurnModel({
		getConnections: () => {
			throw new Error("A Provider SDK turn must not use legacy Connections.");
		},
		model: { modelId: toModelId("gpt-5.6"), providerId: "openai" },
		modelExecutionMode: "provider-sdk",
		promptCacheControls: { enabled: false },
		providerCollection,
		signal: new AbortController().signal,
		thinkingSelection: {},
	});

	expect(providerModel.limits?.maxOutputTokens).toBe(128);
	expect(model).not.toHaveProperty("maxOutputTokens");
});

test("SDK-backed Session sends fail closed instead of routing a Catalog identity to legacy Connections", async () => {
	let legacyAuthorizationRequested = false;
	const providerCollection = fromPartial<ProviderCollection>({
		getAvailable: async () => [],
		getModel: () => undefined,
	});

	await expect(
		resolveSessionTurnModel({
			getConnections: () => {
				legacyAuthorizationRequested = true;
				throw new Error("Legacy Connections must not be used.");
			},
			model: { modelId: toModelId("gpt-5.6"), providerId: "openai" },
			modelExecutionMode: "provider-sdk",
			promptCacheControls: { enabled: false },
			providerCollection,
			signal: new AbortController().signal,
			thinkingSelection: {},
		})
	).rejects.toThrow(
		"Provider Model openai/gpt-5.6 is not available in this Session Host."
	);
	expect(legacyAuthorizationRequested).toBe(false);
});

test("SDK-backed Session execution fails closed when its ProviderCollection is missing", async () => {
	let legacyAuthorizationRequested = false;

	await expect(
		resolveSessionTurnModel({
			getConnections: () => {
				legacyAuthorizationRequested = true;
				throw new Error("Legacy Connections must not be used.");
			},
			model: { modelId: toModelId("gpt-5.6"), providerId: "openai" },
			modelExecutionMode: "provider-sdk",
			promptCacheControls: { enabled: false },
			signal: new AbortController().signal,
			thinkingSelection: {},
		})
	).rejects.toThrow(
		"Provider SDK Session Host is missing its ProviderCollection; Catalog dispatch is disabled."
	);
	expect(legacyAuthorizationRequested).toBe(false);
});

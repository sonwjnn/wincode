import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { toModelId } from "@wincode/agent-core";
import type { ProviderCollection, ProviderModel } from "@wincode/ai";
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
		model: { modelId: toModelId("gpt-5.6"), providerId: "openai" },
		promptCacheControls: { enabled: false },
		providerCollection,
		thinkingSelection: {},
	});

	expect(providerModel.limits?.maxOutputTokens).toBe(128);
	expect(model).not.toHaveProperty("maxOutputTokens");
});

test("SDK-backed Session turns fail closed when exact Provider Model metadata is missing", async () => {
	const providerCollection = fromPartial<ProviderCollection>({
		getAvailable: async () => [],
		getModel: () => undefined,
	});

	await expect(
		resolveSessionTurnModel({
			model: { modelId: toModelId("gpt-5.6"), providerId: "openai" },
			promptCacheControls: { enabled: false },
			providerCollection,
			thinkingSelection: {},
		})
	).rejects.toThrow(
		"Provider Model openai/gpt-5.6 is not available in this Session Host."
	);
});

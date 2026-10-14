import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import { toModelId } from "@wincode/agent-core";
import type { Connections } from "@wincode/ai/connections";
import { defaultChatModelSelection } from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import { createPluginPromptSelectionTarget } from "@/modules/application/plugin-prompt-selection";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";

const selectedModel: ProviderModelSelection = {
	modelId: toModelId("plugin-model"),
	providerId: "plugin-provider",
};

const availableModel: ProviderModel = {
	modelId: selectedModel.modelId,
	protocolId: "test",
	providerId: selectedModel.providerId,
};

const providerController = (models: readonly ProviderModel[]) => ({
	getAvailableModels: async () => models,
});

test("the focused composer rejects a Plugin model that is not invocable", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	const target = createPluginPromptSelectionTarget(providerController([]), {
		setModel: (model) => selectedModels.push(model),
		setThinkingLevel: () => undefined,
	});

	await expect(target.setModel(selectedModel)).resolves.toBe(false);
	expect(selectedModels).toEqual([]);
});

test("a legacy Catalog model requires a connected provider without an SDK controller", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	const target = createPluginPromptSelectionTarget(
		undefined,
		{
			setModel: (model) => selectedModels.push(model),
			setThinkingLevel: () => undefined,
		},
		fromPartial<Pick<Connections, "listProviders">>({
			listProviders: async () => [{ connected: true, id: "openai" }],
		})
	);

	await expect(target.setModel(defaultChatModelSelection)).resolves.toBe(true);
	expect(selectedModels).toEqual([defaultChatModelSelection]);
});

test("the SDK composer does not fall back to a connected Catalog target when its exact model is missing", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	const target = createPluginPromptSelectionTarget(
		providerController([]),
		{
			setModel: (model) => selectedModels.push(model),
			setThinkingLevel: () => undefined,
		},
		fromPartial<Pick<Connections, "listProviders">>({
			listProviders: async () => [{ connected: true, id: "openai" }],
		})
	);

	await expect(target.setModel(defaultChatModelSelection)).resolves.toBe(false);
	expect(selectedModels).toEqual([]);
});

test("the focused composer accepts an exact invocable Provider Model", async () => {
	const selectedModels: ProviderModelSelection[] = [];
	const target = createPluginPromptSelectionTarget(
		providerController([availableModel]),
		{
			setModel: (model) => selectedModels.push(model),
			setThinkingLevel: () => undefined,
		}
	);

	await expect(target.setModel(selectedModel)).resolves.toBe(true);
	expect(selectedModels).toEqual([selectedModel]);
});

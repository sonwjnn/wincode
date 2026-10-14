import type { Connections } from "@wincode/ai/connections";
import type { ThinkingLevel } from "@wincode/ai/models";
import type {
	ProviderModel,
	ProviderModelSelection as ProviderModelIdentity,
} from "@wincode/ai/sdk";
import type { PluginPromptSelectionTarget } from "@/modules/plugins/prompt-selection";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	catalogSelectionForProviderModel,
	normalizeProviderModelSelection,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";

type PromptSelectionMutations = Readonly<{
	setModel: (model: ProviderModelSelection) => void;
	setThinkingLevel: (level: ThinkingLevel | undefined) => void;
}>;

/** Adapts Plugin selection requests to the focused Interactive composer. */
export const createPluginPromptSelectionTarget = (
	providerController:
		| Pick<InteractiveProviderController, "getAvailableModels">
		| undefined,
	promptSelection: PromptSelectionMutations,
	connections?: Pick<Connections, "listProviders">
): PluginPromptSelectionTarget =>
	Object.freeze({
		async setModel(model) {
			const selection = normalizeProviderModelSelection(model);
			if (selection === null) {
				return false;
			}
			if (providerController !== undefined) {
				const availableModels = await providerController.getAvailableModels();
				if (
					!availableModels.some((candidate) =>
						isSameProviderModel(selection, candidate)
					)
				) {
					return false;
				}
				promptSelection.setModel(selection);
				return true;
			}
			if (
				connections === undefined ||
				catalogSelectionForProviderModel(selection) === null
			) {
				return false;
			}
			const connectedProviders = await connections.listProviders();
			if (
				!connectedProviders.some(
					({ connected, id }) => connected && id === selection.providerId
				)
			) {
				return false;
			}
			promptSelection.setModel(selection);
			return true;
		},
		setThinkingLevel: promptSelection.setThinkingLevel,
	});

const isSameProviderModel = (
	selection: ProviderModelIdentity,
	model: ProviderModel
): boolean =>
	model.providerId === selection.providerId &&
	model.modelId === selection.modelId;

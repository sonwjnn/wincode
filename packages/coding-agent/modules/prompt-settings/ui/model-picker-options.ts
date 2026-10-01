import {
	type ChatModelSelection,
	isActiveChatModel,
	type ModelCatalogEntry,
	modelCatalog,
} from "@wincode/ai/models";

export const getActiveModels = (
	catalog: readonly ModelCatalogEntry[] = modelCatalog
): readonly ModelCatalogEntry[] => catalog.filter(isActiveChatModel);

export const getModelsForPicker = (
	catalog: readonly ModelCatalogEntry[] = modelCatalog,
	currentModel?: ChatModelSelection
): readonly ModelCatalogEntry[] => {
	const activeModels = getActiveModels(catalog);
	if (!currentModel) {
		return activeModels;
	}
	const selectedModel = catalog.find(
		(model) =>
			model.connectionProviderId === currentModel.providerId &&
			model.id === currentModel.modelId
	);
	return selectedModel && !isActiveChatModel(selectedModel)
		? [selectedModel, ...activeModels]
		: activeModels;
};

import {
	type ChatModelSelection,
	isActiveChatModel,
	type ModelCatalogEntry,
	modelCatalog,
} from "@wincode/ai/models";
import { getSessionStore } from "@/modules/sessions/storage/get-session-store";
import type { CommandSpec } from "../commands";

export type ModelsAdapterContext = {
	open: (props: {
		models: readonly ModelCatalogEntry[];
		currentModel: ChatModelSelection;
		recentSelections: ChatModelSelection[];
		onSelectModel: (model: ChatModelSelection) => void;
	}) => void;
	currentModel: ChatModelSelection;
	setModel: (model: ChatModelSelection) => void;
};
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

export class ModelsAdapter {
	private readonly ctx: ModelsAdapterContext;

	constructor(ctx: ModelsAdapterContext) {
		this.ctx = ctx;
	}

	execute(_spec: Extract<CommandSpec, { kind: "models" }>) {
		const recentSelections = getSessionStore().listRecentModelSelections(10);
		this.ctx.open({
			models: getModelsForPicker(modelCatalog, this.ctx.currentModel),
			currentModel: this.ctx.currentModel,
			recentSelections,
			onSelectModel: this.ctx.setModel,
		});
	}
}

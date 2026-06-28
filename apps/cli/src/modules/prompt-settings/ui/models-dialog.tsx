import type { SupportedChatModel, SupportedChatModelId } from "@wincode/ai";
import { useCallback } from "react";
import {
	useDialog,
	useDialogEscape,
} from "../../../shared/terminal/dialog/dialog-provider";
import { DialogSearchList } from "../../../shared/terminal/search-list/dialog-search-list";

type ModelsDialogContentProps = {
	currentModel?: SupportedChatModelId;
	models: readonly SupportedChatModel[];
	onSelectModel: (modelId: SupportedChatModelId) => void;
};

export const ModelsDialogContent = ({
	currentModel,
	models,
	onSelectModel,
}: ModelsDialogContentProps) => {
	const dialog = useDialog();

	const handleSelect = useCallback(
		(model: SupportedChatModel) => {
			onSelectModel(model.id);
			dialog.close();
		},
		[dialog, onSelectModel]
	);

	useDialogEscape();

	return (
		<DialogSearchList
			emptyText="No matching models"
			filterFn={(model, query) =>
				`${model.displayName} ${model.id} ${model.provider}`
					.toLowerCase()
					.includes(query.toLowerCase())
			}
			getKey={(model) => model.id}
			items={models}
			onSelect={handleSelect}
			placeholder="Search models"
			renderItem={(model, isSelected) => (
				<text fg={isSelected ? "black" : "white"} selectable={false}>
					{model.id === currentModel ? " • " : "   "}
					{model.displayName}
				</text>
			)}
		/>
	);
};

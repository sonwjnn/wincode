import type { SupportedChatModel, SupportedChatModelId } from "@wincode/ai";
import { useCallback } from "react";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";

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
		<SearchListDialogWrapper
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

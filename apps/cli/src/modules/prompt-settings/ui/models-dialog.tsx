import type { ChatModelSelection, SupportedChatModel } from "@wincode/ai";
import { useCallback } from "react";
import { connectionProviderDisplayNames } from "@/modules/connections";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";

type ModelsDialogContentProps = {
	currentModel?: ChatModelSelection;
	models: readonly SupportedChatModel[];
	onSelectModel: (model: ChatModelSelection) => void;
};

export const ModelsDialogContent = ({
	currentModel,
	models,
	onSelectModel,
}: ModelsDialogContentProps) => {
	const dialog = useDialog();

	const handleSelect = useCallback(
		(model: SupportedChatModel) => {
			onSelectModel({
				modelId: model.id,
				providerId: model.connectionProviderId,
			} as ChatModelSelection);
			dialog.close();
		},
		[dialog, onSelectModel]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No matching models"
			filterFn={(model, query) =>
				`${model.displayName} ${model.id} ${connectionProviderDisplayNames[model.connectionProviderId]}`
					.toLowerCase()
					.includes(query.toLowerCase())
			}
			getKey={(model) => `${model.connectionProviderId}:${model.id}`}
			items={models}
			onSelect={handleSelect}
			placeholder="Search models"
			renderItem={(model, isSelected) => (
				<text fg={isSelected ? "black" : "white"} selectable={false}>
					{model.id === currentModel?.modelId &&
					model.connectionProviderId === currentModel?.providerId
						? " • "
						: "   "}
					{model.displayName} ·{" "}
					{connectionProviderDisplayNames[model.connectionProviderId]}
				</text>
			)}
		/>
	);
};

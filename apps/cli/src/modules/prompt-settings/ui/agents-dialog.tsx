import { codingModes, type ModeType } from "@wincode/ai";
import { useCallback } from "react";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type AgentsDialogContentProps = {
	currentMode?: ModeType;
	onSelectMode: (mode: ModeType) => void;
};

export const AgentsDialogContent = ({
	currentMode,
	onSelectMode,
}: AgentsDialogContentProps) => {
	const dialog = useDialog();

	const handleSelect = useCallback(
		(nextMode: (typeof codingModes)[number]) => {
			onSelectMode(nextMode.value);
			dialog.close();
		},
		[onSelectMode, dialog]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No matching agents"
			filterFn={(item, query) =>
				`${item.displayName} ${item.description}`
					.toLowerCase()
					.includes(query.toLowerCase())
			}
			getKey={(item) => item.value}
			isItemActive={(item) => item.value === currentMode}
			items={codingModes}
			onSelect={handleSelect}
			placeholder="Search agents"
			renderItem={(item, isSelected, isActive) => (
				<SelectableDialogItem
					status={
						isActive ? (
							<text fg={isSelected ? "black" : "white"} selectable={false}>
								{"●"}
							</text>
						) : null
					}
				>
					<text fg={isSelected ? "black" : "white"} selectable={false}>
						{item.displayName}
					</text>
				</SelectableDialogItem>
			)}
		/>
	);
};

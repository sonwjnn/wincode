import { codingModes, type ModeType } from "@wincode/ai";
import { useCallback } from "react";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/terminal/dialog/dialog-provider";
import { SearchListDialogWrapper } from "@/shared/terminal/dialog/search-list-dialog-wrapper";

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
			items={codingModes}
			onSelect={handleSelect}
			placeholder="Search agents"
			renderItem={(item, isSelected) => (
				<text fg={isSelected ? "black" : "white"} selectable={false}>
					{item.value === currentMode ? " • " : "   "}
					{item.displayName}
				</text>
			)}
		/>
	);
};

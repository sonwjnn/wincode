import type { ThinkingLevel } from "@wincode/ai";
import { useCallback } from "react";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type ThinkingLevelDialogContentProps = {
	currentThinkingLevel: ThinkingLevel | undefined;
	thinkingLevels: readonly ThinkingLevel[];
	onSelectThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
};

type ThinkingLevelOption = Readonly<{
	label: string;
	value: ThinkingLevel;
}>;

const thinkingLevelLabel = (level: ThinkingLevel): string => {
	if (level === "xhigh") {
		return "Extra high";
	}
	return level.charAt(0).toUpperCase() + level.slice(1);
};

export const ThinkingLevelDialogContent = ({
	currentThinkingLevel,
	thinkingLevels,
	onSelectThinkingLevel,
}: ThinkingLevelDialogContentProps) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const options: ThinkingLevelOption[] = thinkingLevels.map((value) => ({
		label: thinkingLevelLabel(value),
		value,
	}));

	const handleSelect = useCallback(
		(option: ThinkingLevelOption) => {
			onSelectThinkingLevel(option.value);
			dialog.close();
		},
		[dialog, onSelectThinkingLevel]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No thinking levels available for this model"
			getKey={(option) => `level:${option.value}`}
			getSearchText={(option) => option.label}
			isItemActive={(option) => option.value === currentThinkingLevel}
			items={options}
			onSelect={handleSelect}
			placeholder="Search thinking levels"
			renderItem={(option, isSelected, isActive) => {
				const activeTextColor = isActive ? colors.secondary : colors.text;
				const labelColor = isSelected ? selectedTextColor : activeTextColor;
				return (
					<SelectableDialogItem
						status={
							isActive ? (
								<text fg={labelColor} selectable={false}>
									{"●"}
								</text>
							) : null
						}
					>
						<text fg={labelColor} selectable={false}>
							{option.label}
						</text>
					</SelectableDialogItem>
				);
			}}
		/>
	);
};

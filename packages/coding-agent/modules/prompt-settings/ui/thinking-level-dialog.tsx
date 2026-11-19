import type { ThinkingLevel } from "@wincode/ai";
import { SettingsList, type SettingsListOption } from "@wincode/tui";
import { useCallback } from "react";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";

type ThinkingLevelDialogContentProps = {
	currentThinkingLevel: ThinkingLevel | undefined;
	thinkingLevels: readonly ThinkingLevel[];
	onSelectThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
};

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
	const options: SettingsListOption<ThinkingLevel>[] = thinkingLevels.map(
		(value) => ({
			id: `level:${value}`,
			label: thinkingLevelLabel(value),
			value,
		})
	);

	const handleSelect = useCallback(
		(level: ThinkingLevel) => {
			onSelectThinkingLevel(level);
			dialog.close();
		},
		[dialog, onSelectThinkingLevel]
	);

	useDialogEscape();

	return (
		<SettingsList
			currentValue={currentThinkingLevel}
			emptyText="No thinking levels available for this model"
			onSelect={handleSelect}
			options={options}
			placeholder="Search thinking levels"
		/>
	);
};

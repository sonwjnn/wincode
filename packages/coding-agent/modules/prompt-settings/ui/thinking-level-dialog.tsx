import {
	type ChatModelSelection,
	getSupportedThinkingLevels,
	type SupportedChatModel,
	supportedChatModelIdSchema,
	type ThinkingLevel,
} from "@wincode/ai/models";
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
	currentModel: SupportedChatModel;
	onSelectDefault: () => void;
	onSelectThinkingLevel: (thinkingLevel: ThinkingLevel) => void;
};

type ThinkingLevelOption =
	| Readonly<{ kind: "default"; label: string }>
	| Readonly<{ kind: "level"; label: string; value: ThinkingLevel }>;

const thinkingLevelLabel = (level: ThinkingLevel): string => {
	if (level === "xhigh") {
		return "Extra high";
	}
	return level.charAt(0).toUpperCase() + level.slice(1);
};

export const ThinkingLevelDialogContent = ({
	currentThinkingLevel,
	currentModel,
	onSelectDefault,
	onSelectThinkingLevel,
}: ThinkingLevelDialogContentProps) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const modelSelection: ChatModelSelection = {
		modelId: supportedChatModelIdSchema.parse(currentModel.id),
		providerId: currentModel.connectionProviderId,
	};
	const options: ThinkingLevelOption[] = [
		{ kind: "default", label: "Provider default" },
		...getSupportedThinkingLevels(modelSelection).map((value) => ({
			kind: "level" as const,
			label: thinkingLevelLabel(value),
			value,
		})),
	];

	const handleSelect = useCallback(
		(option: ThinkingLevelOption) => {
			if (option.kind === "default") {
				onSelectDefault();
			} else {
				onSelectThinkingLevel(option.value);
			}
			dialog.close();
		},
		[dialog, onSelectDefault, onSelectThinkingLevel]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No thinking levels available for this model"
			getKey={(option) =>
				option.kind === "default" ? "default" : `level:${option.value}`
			}
			getSearchText={(option) => option.label}
			isItemActive={(option) =>
				option.kind === "default"
					? currentThinkingLevel === undefined
					: option.value === currentThinkingLevel
			}
			items={options}
			onSelect={handleSelect}
			placeholder="Search thinking levels"
			renderItem={(option, isSelected, isActive) => {
				const activeTextColor =
					isActive && option.kind !== "default"
						? colors.secondary
						: colors.text;
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

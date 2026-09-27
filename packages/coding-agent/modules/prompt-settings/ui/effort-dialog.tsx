import {
	type ChatModelSelection,
	type Effort,
	getSupportedModelEfforts,
	getSupportedReasoningModes,
	type ReasoningMode,
	type SupportedChatModel,
	supportedChatModelIdSchema,
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

type EffortDialogContentProps = {
	currentEffort: Effort | undefined;
	currentModel: SupportedChatModel;
	currentReasoningMode: ReasoningMode | undefined;
	onSelectDefault: () => void;
	onSelectEffort: (effort: Effort) => void;
	onSelectReasoningMode: (reasoningMode: ReasoningMode) => void;
};

type ReasoningOption =
	| { kind: "default"; label: string }
	| { kind: "effort"; label: string; value: Effort }
	| { kind: "mode"; label: string; value: ReasoningMode };
export const EffortDialogContent = ({
	currentEffort,
	currentModel,
	currentReasoningMode,
	onSelectDefault,
	onSelectEffort,
	onSelectReasoningMode,
}: EffortDialogContentProps) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const modelSelection: ChatModelSelection = {
		modelId: supportedChatModelIdSchema.parse(currentModel.id),
		providerId: currentModel.connectionProviderId,
	};
	const choices: ReasoningOption[] = [
		...getSupportedReasoningModes(modelSelection).map((value) => ({
			kind: "mode" as const,
			label: `Reasoning Mode: ${value}`,
			value,
		})),
		...getSupportedModelEfforts(modelSelection).map((value) => ({
			kind: "effort" as const,
			label: `Effort: ${value}`,
			value,
		})),
	];
	const options: ReasoningOption[] =
		choices.length === 0
			? []
			: [{ kind: "default", label: "default" }, ...choices];

	const handleSelect = useCallback(
		(option: ReasoningOption) => {
			switch (option.kind) {
				case "default":
					onSelectDefault();
					break;
				case "effort":
					onSelectEffort(option.value);
					break;
				case "mode":
					onSelectReasoningMode(option.value);
					break;
				default: {
					const _exhaustive: never = option;
					return _exhaustive;
				}
			}
			dialog.close();
		},
		[dialog, onSelectDefault, onSelectEffort, onSelectReasoningMode]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No Efforts or Reasoning Modes available"
			getKey={(option) =>
				option.kind === "default" ? "default" : `${option.kind}:${option.value}`
			}
			getSearchText={(option) => option.label}
			isItemActive={(option) => {
				switch (option.kind) {
					case "default":
						return (
							currentEffort === undefined && currentReasoningMode === undefined
						);
					case "effort":
						return option.value === currentEffort;
					case "mode":
						return option.value === currentReasoningMode;
					default: {
						const _exhaustive: never = option;
						return _exhaustive;
					}
				}
			}}
			items={options}
			onSelect={handleSelect}
			placeholder="Search Efforts and Reasoning Modes"
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

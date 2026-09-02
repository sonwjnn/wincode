import {
	type ChatModelSelection,
	getSupportedModelVariants,
	type ModelVariant,
	type SupportedChatModel,
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

type VariantsDialogContentProps = {
	currentModel: SupportedChatModel;
	currentVariant: ModelVariant | undefined;
	onSelectVariant: (variant: ModelVariant | undefined) => void;
};

type VariantOption = {
	label: string;
	value: ModelVariant | undefined;
};

export const VariantsDialogContent = ({
	currentModel,
	currentVariant,
	onSelectVariant,
}: VariantsDialogContentProps) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const modelSelection: ChatModelSelection = {
		modelId: currentModel.id,
		providerId: currentModel.connectionProviderId,
	};
	const supportedVariants = getSupportedModelVariants(modelSelection);
	const variants: VariantOption[] =
		supportedVariants.length === 0
			? []
			: [
					{ label: "Default", value: undefined },
					...supportedVariants.map((variant) => ({
						label: variant,
						value: variant,
					})),
				];

	const handleSelect = useCallback(
		(value: VariantOption) => {
			onSelectVariant(value.value);
			dialog.close();
		},
		[dialog, onSelectVariant]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper
			emptyText="No variants available"
			filterFn={(variant, query) =>
				`${variant.label}`.toLowerCase().includes(query.toLowerCase())
			}
			getKey={(variant) => variant.label}
			isItemActive={(variant) => variant.value === currentVariant}
			items={variants}
			onSelect={handleSelect}
			placeholder="Search variants"
			renderItem={(variant, isSelected, isActive) => {
				const activeTextColor =
					isActive && variant.value !== undefined
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
							{variant.label}
						</text>
					</SelectableDialogItem>
				);
			}}
		/>
	);
};

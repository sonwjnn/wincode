import {
	type ChatModelSelection,
	getSupportedModelVariants,
	type ModelVariant,
	type SupportedChatModel,
} from "@wincode/ai";
import { useCallback } from "react";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";

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
			items={variants}
			onSelect={handleSelect}
			placeholder="Search variants"
			renderItem={(variant, isSelected) => (
				<text fg={isSelected ? "black" : "white"} selectable={false}>
					{variant.value === currentVariant ? " • " : "   "}
					{variant.label}
				</text>
			)}
		/>
	);
};

import { TextAttributes } from "@opentui/core";
import { useCallback } from "react";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import type { ConnectionProviderSummary } from "../contract";
import {
	CONNECTION_LABEL_COLUMN_WIDTH,
	type ConnectionMethodOption,
	getConnectionMethodOptions,
} from "./connection-dialog-options";

type ConnectionMethodPickerDialogContentProps = {
	provider: ConnectionProviderSummary;
	onSelectMethod: (methodId: "browser" | "api-key") => void;
};

export function ConnectionMethodPickerDialogContent({
	provider,
	onSelectMethod,
}: ConnectionMethodPickerDialogContentProps) {
	const methods = getConnectionMethodOptions(provider);
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);

	const handleSelect = useCallback(
		(method: ConnectionMethodOption) => {
			onSelectMethod(method.id);
		},
		[onSelectMethod]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper<ConnectionMethodOption>
			emptyText="No available methods"
			filterFn={(method, query) => {
				const value = `${method.label} ${method.details}`;
				return value.toLowerCase().includes(query.toLowerCase());
			}}
			getKey={(method) => method.id}
			items={methods}
			onSelect={handleSelect}
			placeholder="Search methods"
			renderItem={(method, isSelected) => (
				<SelectableDialogItem>
					<box flexDirection="row" flexGrow={1} gap={1}>
						<box flexShrink={0} width={CONNECTION_LABEL_COLUMN_WIDTH}>
							<text
								fg={isSelected ? selectedTextColor : colors.text}
								selectable={false}
							>
								{method.label}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text
								attributes={isSelected ? undefined : TextAttributes.DIM}
								fg={isSelected ? selectedTextColor : colors.textMuted}
								selectable={false}
							>
								{method.details}
							</text>
						</box>
					</box>
				</SelectableDialogItem>
			)}
		/>
	);
}

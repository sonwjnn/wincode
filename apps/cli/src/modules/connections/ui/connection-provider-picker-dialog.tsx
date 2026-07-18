import { TextAttributes } from "@opentui/core";
import { useCallback } from "react";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import type { ConnectionProviderSummary } from "../contract";
import {
	CONNECTION_LABEL_COLUMN_WIDTH,
	getConnectionProviderDetails,
} from "./connection-dialog-options";

type ConnectionProviderPickerDialogContentProps = {
	onSelectProvider: (providerId: ConnectionProviderSummary["id"]) => void;
	connectedProviderIds?: readonly ConnectionProviderSummary["id"][];
	providers: readonly ConnectionProviderSummary[];
};

export function ConnectionProviderPickerDialogContent({
	onSelectProvider,
	connectedProviderIds,
	providers,
}: ConnectionProviderPickerDialogContentProps) {
	const connectedProviders = new Set(connectedProviderIds ?? []);

	const handleSelect = useCallback(
		(provider: ConnectionProviderSummary) => {
			onSelectProvider(provider.id);
		},
		[onSelectProvider]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper<ConnectionProviderSummary>
			emptyText="No matching providers"
			filterFn={(provider, query) => {
				const value = `${provider.displayName} ${getConnectionProviderDetails(provider)} ${provider.id}`;
				return value.toLowerCase().includes(query.toLowerCase());
			}}
			getKey={(provider) => provider.id}
			isItemActive={(provider) => connectedProviders.has(provider.id)}
			items={providers}
			onSelect={handleSelect}
			placeholder="Search providers"
			renderItem={(provider, isSelected, isActive) => (
				<SelectableDialogItem
					status={
						isActive ? (
							<text fg={isSelected ? "black" : "#22C55E"} selectable={false}>
								{"✓"}
							</text>
						) : null
					}
				>
					<box flexDirection="row" gap={1}>
						<box flexShrink={0} width={CONNECTION_LABEL_COLUMN_WIDTH}>
							<text fg={isSelected ? "black" : "white"} selectable={false}>
								{provider.displayName}
							</text>
						</box>
						<box flexGrow={1} flexShrink={1} overflow="hidden">
							<text
								attributes={isSelected ? undefined : TextAttributes.DIM}
								fg={isSelected ? "black" : "#9AA0A6"}
								selectable={false}
							>
								{getConnectionProviderDetails(provider)}
							</text>
						</box>
					</box>
				</SelectableDialogItem>
			)}
		/>
	);
}

import { TextAttributes } from "@opentui/core";
import { useCallback } from "react";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import type { ProviderId } from "../types";
import {
	CONNECTION_LABEL_COLUMN_WIDTH,
	CONNECTION_PROVIDERS,
	type ConnectionProviderOption,
} from "./connection-dialog-options";

type ConnectionProviderPickerDialogContentProps = {
	onSelectProvider: (providerId: ConnectionProviderOption["id"]) => void;
	connectedProviderIds?: readonly ProviderId[];
};

export function ConnectionProviderPickerDialogContent({
	onSelectProvider,
	connectedProviderIds,
}: ConnectionProviderPickerDialogContentProps) {
	const connectedProviders = new Set(connectedProviderIds ?? []);

	const handleSelect = useCallback(
		(provider: ConnectionProviderOption) => {
			onSelectProvider(provider.id);
		},
		[onSelectProvider]
	);

	useDialogEscape();

	return (
		<SearchListDialogWrapper<ConnectionProviderOption>
			emptyText="No matching providers"
			filterFn={(provider, query) => {
				const value = `${provider.label} ${provider.details} ${provider.id}`;
				return value.toLowerCase().includes(query.toLowerCase());
			}}
			getKey={(provider) => provider.id}
			items={CONNECTION_PROVIDERS}
			onSelect={handleSelect}
			placeholder="Search providers"
			renderItem={(provider, isSelected) => (
				<box flexDirection="row" flexGrow={1} gap={1}>
					<box flexShrink={0} width={3}>
						{connectedProviders.has(provider.id) ? (
							<text
								fg={isSelected ? "black" : "#22C55E"}
								marginLeft={1}
								selectable={false}
								width={2}
							>
								{"✓"}
							</text>
						) : null}
					</box>
					<box flexShrink={0} width={CONNECTION_LABEL_COLUMN_WIDTH}>
						<text fg={isSelected ? "black" : "white"} selectable={false}>
							{provider.label}
						</text>
					</box>
					<box flexGrow={1} flexShrink={1} overflow="hidden">
						<text
							attributes={isSelected ? undefined : TextAttributes.DIM}
							fg={isSelected ? "black" : "#9AA0A6"}
							selectable={false}
						>
							{provider.details}
						</text>
					</box>
				</box>
			)}
		/>
	);
}

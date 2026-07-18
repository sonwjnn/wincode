import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import {
	type ChatModelSelection,
	connectionProviderIds,
	type SupportedChatModel,
} from "@wincode/ai";
import { useCallback } from "react";
import { connectionProviderDisplayNames } from "@/modules/connections";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type Row =
	| { kind: "header"; label: string }
	| { kind: "model"; model: SupportedChatModel; recent: boolean }
	| { kind: "spacer"; id: string };
type Props = {
	currentModel?: ChatModelSelection;
	models: readonly SupportedChatModel[];
	recentSelections: readonly ChatModelSelection[];
	onSelectModel: (model: ChatModelSelection) => void;
};

const VERSION_SUFFIX = /\s+\d{8}$/;
const formatModelLabel = (displayName: string): string =>
	displayName.replace(VERSION_SUFFIX, " (latest)");

export const ModelsDialogContent = ({
	currentModel,
	models,
	recentSelections,
	onSelectModel,
}: Props) => {
	const dialog = useDialog();
	const { height } = useTerminalDimensions();
	const { colors } = useTheme();
	const byKey = new Map(
		models.map((model) => [`${model.connectionProviderId}:${model.id}`, model])
	);
	const recent = recentSelections
		.map((s) => byKey.get(`${s.providerId}:${s.modelId}`))
		.filter((m): m is SupportedChatModel => Boolean(m));
	const recentKeys = new Set(
		recent.map((model) => `${model.connectionProviderId}:${model.id}`)
	);
	const providerIds = connectionProviderIds.filter((providerId) =>
		models.some(
			(model) =>
				model.connectionProviderId === providerId &&
				!recentKeys.has(`${model.connectionProviderId}:${model.id}`)
		)
	);
	const rows: Row[] = [
		...(recent.length
			? [
					{ kind: "header" as const, label: "Recent" },
					...recent.map((model) => ({
						kind: "model" as const,
						model,
						recent: true,
					})),
				]
			: []),
		...providerIds.flatMap((providerId, index) => [
			...(recent.length > 0 || index > 0
				? [{ id: `spacer:${providerId}`, kind: "spacer" as const }]
				: []),
			{
				kind: "header" as const,
				label: connectionProviderDisplayNames[providerId],
			},
			...models
				.filter(
					(model) =>
						model.connectionProviderId === providerId &&
						!recentKeys.has(`${model.connectionProviderId}:${model.id}`)
				)
				.map((model) => ({ kind: "model" as const, model, recent: false })),
		]),
	];
	const handleSelect = useCallback(
		(model: SupportedChatModel) => {
			onSelectModel({
				modelId: model.id,
				providerId: model.connectionProviderId,
			});
			dialog.close();
		},
		[dialog, onSelectModel]
	);
	useDialogEscape();
	return (
		<SearchListDialogWrapper
			emptyText="No matching models"
			filterFn={(row, query) => {
				if (row.kind !== "model") {
					return query.length === 0;
				}
				return `${row.model.displayName} ${row.model.id} ${connectionProviderDisplayNames[row.model.connectionProviderId]}`
					.toLowerCase()
					.includes(query.toLowerCase());
			}}
			getKey={(row) => {
				if (row.kind === "header") {
					return `header:${row.label}`;
				}
				if (row.kind === "spacer") {
					return row.id;
				}
				return `${row.recent ? "recent" : "provider"}:${row.model.connectionProviderId}:${row.model.id}`;
			}}
			isItemActive={(row) =>
				row.kind === "model" &&
				row.model.id === currentModel?.modelId &&
				row.model.connectionProviderId === currentModel?.providerId
			}
			isItemSelectable={(row) => row.kind === "model"}
			items={rows}
			maxVisibleItems={Math.max(1, Math.floor(height * 0.5))}
			onSelect={(row) => row.kind === "model" && handleSelect(row.model)}
			placeholder="Search models"
			// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: grouped and search row variants share selection styling.
			renderItem={(row, isSelected, isActive, isSearching) => {
				if (row.kind === "spacer") {
					return null;
				}
				if (row.kind === "header") {
					return (
						<SelectableDialogItem>
							<text fg={colors.primary}>{row.label}</text>
						</SelectableDialogItem>
					);
				}
				return (
					<SelectableDialogItem
						status={
							isActive ? (
								<text fg={isSelected ? "black" : "white"}>●</text>
							) : null
						}
					>
						<box
							flexDirection="row"
							flexGrow={1}
							justifyContent={isSearching ? "space-between" : "flex-start"}
							paddingRight={isSearching ? 3 : 0}
						>
							<text fg={isSelected ? "black" : "white"}>
								{formatModelLabel(row.model.displayName)}
							</text>
							{(row.recent || isSearching) && (
								<>
									{!isSearching && (
										<text fg={isSelected ? "black" : "white"}> · </text>
									)}
									<text
										attributes={isSelected ? undefined : TextAttributes.DIM}
										fg={isSelected ? "black" : "#9AA0A6"}
									>
										{
											connectionProviderDisplayNames[
												row.model.connectionProviderId
											]
										}
									</text>
								</>
							)}
						</box>
					</SelectableDialogItem>
				);
			}}
		/>
	);
};

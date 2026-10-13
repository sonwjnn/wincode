import { toModelId } from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai/sdk";
import { getErrorMessage } from "@wincode/utils";
import { useCallback, useEffect, useState } from "react";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type Props = Readonly<{
	controller: InteractiveProviderController;
	currentModel: ProviderModelSelection;
	onSelectModel: (model: ProviderModelSelection) => void;
}>;

type Row =
	| Readonly<{ kind: "refresh" }>
	| Readonly<{ kind: "model"; model: ProviderModel }>;

/** Selects authenticated Provider Models from the current Host's SDK collection. */
export const ProviderModelsDialogContent = ({
	controller,
	currentModel,
	onSelectModel,
}: Props) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const [models, setModels] = useState<readonly ProviderModel[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);

	useEffect(() => {
		let active = true;
		void controller
			.getAvailableModels()
			.then((available) => {
				if (active) {
					setModels(available);
				}
			})
			.catch((loadError: unknown) => {
				if (active) {
					setError(
						getErrorMessage(loadError, "Could not restore Known Models.")
					);
				}
			})
			.finally(() => {
				if (active) {
					setIsLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [controller]);

	const refreshModels = useCallback(async () => {
		setError(null);
		setIsRefreshing(true);
		try {
			setModels(await controller.refreshModels());
		} catch (refreshError) {
			setError(
				getErrorMessage(
					refreshError,
					"Known Model refresh failed; the last-known models were retained."
				)
			);
		} finally {
			setIsRefreshing(false);
		}
	}, [controller]);
	const rows: Row[] = [
		{ kind: "refresh" },
		...models.map((model) => ({ kind: "model" as const, model })),
	];
	useDialogEscape();

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.textMuted}>
				Available models are filtered by the current user's credentials.
				Providers are contacted only when you refresh.
			</text>
			{error ? <text fg={colors.error}>{error}</text> : null}
			{isLoading ? (
				<text fg={colors.textMuted}>Restoring Known Models…</text>
			) : null}
			<SearchListDialogWrapper
				emptyText="No authenticated Provider Models. Connect a Provider or refresh Known Models."
				getKey={(row) =>
					row.kind === "refresh"
						? "refresh"
						: `model:${row.model.providerId}:${row.model.modelId}`
				}
				getSearchText={(row) =>
					row.kind === "model"
						? `${row.model.modelId} ${row.model.providerId}`
						: "refresh"
				}
				isItemActive={(row) =>
					row.kind === "model" &&
					row.model.providerId === currentModel.providerId &&
					row.model.modelId === currentModel.modelId
				}
				isItemSelectable={() => !(isLoading || isRefreshing)}
				items={rows}
				onSelect={(row) => {
					if (row.kind === "refresh") {
						void refreshModels();
						return;
					}
					onSelectModel({
						modelId: toModelId(row.model.modelId),
						providerId: row.model.providerId,
					});
					dialog.close();
				}}
				placeholder="Search Provider Models"
				renderItem={(row, isSelected, isActive) => {
					let foreground = colors.text;
					let label: string;
					if (row.kind === "refresh") {
						foreground = colors.primary;
						label = isRefreshing
							? "Refreshing Known Models…"
							: "Refresh Known Models";
					} else {
						label = row.model.modelId;
					}
					if (isSelected) {
						foreground = selectedTextColor;
					}
					return (
						<SelectableDialogItem
							status={isActive ? <text fg={colors.primary}>●</text> : null}
						>
							<text fg={foreground}>{label}</text>
						</SelectableDialogItem>
					);
				}}
			/>
		</box>
	);
};

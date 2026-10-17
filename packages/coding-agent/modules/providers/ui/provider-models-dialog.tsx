import type { ProviderModel } from "@wincode/ai";
import { getErrorMessage } from "@wincode/utils";
import { useCallback, useEffect, useState } from "react";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import {
	isSameProviderModelIdentity,
	type ProviderModelSelection,
	type ProviderModelSelectionCandidate,
	STALE_PROVIDER_MODEL_SELECTION_MESSAGE,
} from "@/modules/providers/provider-model-selection";
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
	onSelectModel: (
		model: ProviderModel,
		selection: ProviderModelSelection
	) => void | Promise<void>;
}>;

type Row =
	| Readonly<{ kind: "refresh" }>
	| Readonly<{ candidate: ProviderModelSelectionCandidate; kind: "model" }>;

/** Selects Provider Models with the owner and composition snapshot that fetched them. */
export const ProviderModelsDialogContent = ({
	controller,
	currentModel,
	onSelectModel,
}: Props) => {
	const dialog = useDialog();
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const [candidates, setCandidates] = useState<
		readonly ProviderModelSelectionCandidate[]
	>([]);
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [isSelecting, setIsSelecting] = useState(false);

	useEffect(() => {
		let active = true;
		const getAvailableCandidates =
			controller.getAvailableProviderModelSelectionCandidates;
		if (getAvailableCandidates === undefined) {
			setError(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
			setIsLoading(false);
			return () => {
				active = false;
			};
		}
		void getAvailableCandidates()
			.then((available) => {
				if (active) {
					setCandidates(available);
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
			const refreshCandidates =
				controller.refreshProviderModelSelectionCandidates;
			if (refreshCandidates === undefined) {
				throw new Error(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
			}
			setCandidates(await refreshCandidates());
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
	const selectCandidate = useCallback(
		async (candidate: ProviderModelSelectionCandidate): Promise<void> => {
			setError(null);
			setIsSelecting(true);
			try {
				const select = controller.selectProviderModelSelectionCandidate;
				if (select === undefined) {
					throw new Error(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
				}
				await select(candidate, onSelectModel);
				dialog.close();
			} catch (selectionError) {
				setError(
					getErrorMessage(
						selectionError,
						"Could not select this Provider Model."
					)
				);
			} finally {
				setIsSelecting(false);
			}
		},
		[controller, dialog, onSelectModel]
	);
	const rows: Row[] = [
		{ kind: "refresh" },
		...candidates.map((candidate) => ({ kind: "model" as const, candidate })),
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
						: `model:${row.candidate.model.providerId}:${row.candidate.model.modelId}`
				}
				getSearchText={(row) =>
					row.kind === "model"
						? `${row.candidate.model.modelId} ${row.candidate.model.providerId}`
						: "refresh"
				}
				isItemActive={(row) =>
					row.kind === "model" &&
					isSameProviderModelIdentity(row.candidate.model, currentModel)
				}
				isItemSelectable={() => !(isLoading || isRefreshing || isSelecting)}
				items={rows}
				onSelect={(row) => {
					if (row.kind === "refresh") {
						void refreshModels();
						return;
					}
					void selectCandidate(row.candidate);
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
						label = row.candidate.model.modelId;
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

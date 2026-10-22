import { useTerminalDimensions } from "@opentui/react";
import type { ProviderModel } from "@wincode/ai";
import { getErrorMessage } from "@wincode/utils";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	BUILT_IN_PROVIDER_CATALOG,
	isBuiltInProviderId,
} from "@/modules/providers/built-in-provider-catalog";
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
import { DialogInset } from "@/shared/ui/dialog-inset";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

type Props = Readonly<{
	controller: InteractiveProviderController;
	currentModel: ProviderModelSelection;
	recentSelections?: readonly ProviderModelSelection[];
	onSelectModel: (
		model: ProviderModel,
		selection: ProviderModelSelection
	) => void | Promise<void>;
}>;

type Row =
	| Readonly<{ kind: "header"; label: string; sectionKey: string }>
	| Readonly<{
			kind: "model";
			candidate: ProviderModelSelectionCandidate;
			recent: boolean;
	  }>;

type ModelPickerRowProps = Readonly<{
	isActive: boolean;
	isSearching: boolean;
	isSelected: boolean;
	providerName: (providerId: string) => string;
	row: Row;
}>;

const EMPTY_RECENT_MODEL_SELECTIONS: readonly ProviderModelSelection[] = [];
const PROVIDER_SDK_SUFFIX = / Provider SDK$/u;

type RefreshStatus = "refreshing" | "success" | null;

const getRefreshErrorMessage = (
	failedProviderIds: readonly string[]
): string | null => {
	if (failedProviderIds.length === 0) {
		return null;
	}
	if (failedProviderIds.length === 1) {
		return `Could not refresh ${failedProviderIds[0]}; showing cached models.`;
	}
	return `Could not refresh ${failedProviderIds.length} model catalogs (${failedProviderIds.join(", ")}); showing cached models.`;
};

const getModelSectionKey = (row: Row): string => {
	if (row.kind === "header") {
		return row.sectionKey;
	}
	return row.recent ? "recent" : `provider:${row.candidate.model.providerId}`;
};

const getProviderDisplayNames = (
	controller: InteractiveProviderController
): ReadonlyMap<string, string> => {
	const displayNames = new Map<string, string>();
	for (const [providerId, definition] of Object.entries(
		BUILT_IN_PROVIDER_CATALOG
	)) {
		displayNames.set(
			providerId,
			definition.displayName.replace(PROVIDER_SDK_SUFFIX, "")
		);
	}
	for (const registration of controller.getPluginProviderRegistrations?.() ??
		[]) {
		displayNames.set(registration.providerId, registration.displayName);
	}
	return displayNames;
};

const getModelSearchText = (
	row: Row,
	providerName: (providerId: string) => string
): string => {
	switch (row.kind) {
		case "header":
			return "";
		case "model":
			return `${row.candidate.model.modelId} ${providerName(row.candidate.model.providerId)} ${row.candidate.model.providerId}`;
		default:
			return "";
	}
};

const ModelPickerRow = ({
	isActive,
	isSearching,
	isSelected,
	providerName,
	row,
}: ModelPickerRowProps) => {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	if (row.kind === "header") {
		return (
			<SelectableDialogItem>
				<text fg={colors.primary}>{row.label}</text>
			</SelectableDialogItem>
		);
	}
	const primaryTextColor = isSelected ? selectedTextColor : colors.text;
	const secondaryTextColor = isSelected ? selectedTextColor : colors.textMuted;
	const providerDisplayName = providerName(row.candidate.model.providerId);
	return (
		<SelectableDialogItem
			status={isActive ? <text fg={primaryTextColor}>●</text> : null}
		>
			<box
				flexDirection="row"
				flexGrow={1}
				justifyContent={isSearching ? "space-between" : "flex-start"}
				paddingRight={isSearching ? 3 : 0}
			>
				<text fg={primaryTextColor}>{row.candidate.model.modelId}</text>
				{(row.recent || isSearching) && (
					<>
						{!isSearching && <text fg={primaryTextColor}> · </text>}
						<text fg={secondaryTextColor}>{providerDisplayName}</text>
					</>
				)}
			</box>
		</SelectableDialogItem>
	);
};

/** Selects Provider Models with the owner and composition snapshot that fetched them. */
export const ProviderModelsDialogContent = ({
	controller,
	currentModel,
	onSelectModel,
	recentSelections = EMPTY_RECENT_MODEL_SELECTIONS,
}: Props) => {
	const dialog = useDialog();
	const { height } = useTerminalDimensions();
	const { colors } = useTheme();
	const providerDisplayNames = useMemo(
		() => getProviderDisplayNames(controller),
		[controller]
	);
	const [candidates, setCandidates] = useState<
		readonly ProviderModelSelectionCandidate[]
	>([]);
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>(null);
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

	const refreshModels = useCallback(
		async (signal?: AbortSignal): Promise<void> => {
			const isAborted = (): boolean => signal?.aborted === true;
			if (isAborted()) {
				return;
			}
			setRefreshStatus("refreshing");
			try {
				const refreshCandidates =
					controller.refreshProviderModelSelectionCandidates;
				if (refreshCandidates === undefined) {
					throw new Error(STALE_PROVIDER_MODEL_SELECTION_MESSAGE);
				}
				const refreshResult = await refreshCandidates(
					signal === undefined ? undefined : { signal }
				);
				if (!isAborted()) {
					setCandidates(refreshResult.candidates);
					const refreshError = getRefreshErrorMessage(
						refreshResult.failedProviderIds
					);
					setError(refreshError);
					setRefreshStatus(
						refreshError === null &&
							refreshResult.refreshedProviderIds.length > 0
							? "success"
							: null
					);
				}
			} catch (refreshError) {
				if (!isAborted()) {
					setError(
						getErrorMessage(
							refreshError,
							"Could not refresh model catalogs; showing cached models."
						)
					);
					setRefreshStatus(null);
				}
			}
		},
		[controller]
	);

	useEffect(() => {
		if (isLoading) {
			return;
		}
		if (
			controller.getAvailableProviderModelSelectionCandidates === undefined ||
			controller.refreshProviderModelSelectionCandidates === undefined
		) {
			setRefreshStatus(null);
			return;
		}

		const abortController = new AbortController();
		void refreshModels(abortController.signal);
		return () => abortController.abort();
	}, [controller, isLoading, refreshModels]);

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

	const recentKeys = new Set<string>();
	const recentCandidates = recentSelections.flatMap((selection) => {
		const candidate = candidates.find(({ model }) =>
			isSameProviderModelIdentity(model, selection)
		);
		if (candidate === undefined) {
			return [];
		}
		const key = `${candidate.model.providerId}:${candidate.model.modelId}`;
		if (recentKeys.has(key)) {
			return [];
		}
		recentKeys.add(key);
		return [candidate];
	});
	const candidateProviderIds = new Set(
		candidates.map(({ model }) => model.providerId)
	);
	const providerIds = [
		...Object.keys(BUILT_IN_PROVIDER_CATALOG).filter((providerId) =>
			candidateProviderIds.has(providerId)
		),
		...[...candidateProviderIds]
			.filter((providerId) => !isBuiltInProviderId(providerId))
			.sort((left, right) =>
				(providerDisplayNames.get(left) ?? left).localeCompare(
					providerDisplayNames.get(right) ?? right
				)
			),
	];
	const providerName = (providerId: string): string =>
		providerDisplayNames.get(providerId) ?? providerId;
	const rows: Row[] = [
		...(recentCandidates.length === 0
			? []
			: [
					{ kind: "header" as const, label: "Recent", sectionKey: "recent" },
					...recentCandidates.map((candidate) => ({
						kind: "model" as const,
						candidate,
						recent: true,
					})),
				]),
		...providerIds.flatMap((providerId) => {
			const providerCandidates = candidates.filter(
				({ model }) =>
					model.providerId === providerId &&
					!recentKeys.has(`${model.providerId}:${model.modelId}`)
			);
			return providerCandidates.length === 0
				? []
				: [
						{
							kind: "header" as const,
							label: providerName(providerId),
							sectionKey: `provider:${providerId}`,
						},
						...providerCandidates.map((candidate) => ({
							kind: "model" as const,
							candidate,
							recent: false,
						})),
					];
		}),
	];
	useDialogEscape();

	return (
		<>
			{isLoading ? (
				<DialogInset>
					<text fg={colors.textMuted}>Restoring Known Models…</text>
				</DialogInset>
			) : null}
			{refreshStatus === "refreshing" ? (
				<DialogInset>
					<text fg={colors.textMuted}>Refreshing model catalogs…</text>
				</DialogInset>
			) : null}
			{refreshStatus === "success" ? (
				<DialogInset>
					<text fg={colors.success}>Model catalogs refreshed.</text>
				</DialogInset>
			) : null}
			<SearchListDialogWrapper
				emptyText="No matching models"
				error={error}
				getItemSectionKey={getModelSectionKey}
				getKey={(row) => {
					if (row.kind === "header") {
						return `header:${row.label}`;
					}
					return `model:${row.candidate.model.providerId}:${row.candidate.model.modelId}`;
				}}
				getSearchText={(row) => getModelSearchText(row, providerName)}
				isItemActive={(row) =>
					row.kind === "model" &&
					isSameProviderModelIdentity(row.candidate.model, currentModel)
				}
				isItemSelectable={(row) =>
					!(isLoading || isSelecting) && row.kind === "model"
				}
				items={rows}
				maxVisibleItems={Math.max(1, Math.floor(height * 0.5))}
				onSelect={(row) => {
					if (row.kind === "model") {
						void selectCandidate(row.candidate);
					}
				}}
				placeholder="Search models"
				renderItem={(row, isSelected, isActive, isSearching) => (
					<ModelPickerRow
						isActive={isActive}
						isSearching={isSearching}
						isSelected={isSelected}
						providerName={providerName}
						row={row}
					/>
				)}
			/>
		</>
	);
};

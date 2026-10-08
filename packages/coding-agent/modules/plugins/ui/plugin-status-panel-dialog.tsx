import { TextAttributes } from "@opentui/core";
import { isUndefined } from "@wincode/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	PluginStatus,
	PluginStatusItem,
	PluginStatusPanelSnapshot,
} from "@/modules/plugins/public";
import type {
	PluginRuntime,
	PluginStatusPanelDescriptor,
} from "@/modules/plugins/runtime";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";

const statusLabel = (status: PluginStatus): string => {
	switch (status) {
		case "success":
			return "Ready";
		case "warning":
			return "Warning";
		case "error":
			return "Error";
		case "pending":
			return "Loading";
		default:
			return "Idle";
	}
};

type StatusPanelRowProps = Readonly<{
	isBusy: boolean;
	isSelected: boolean;
	item: PluginStatusItem;
}>;

const StatusPanelRow = ({ isBusy, isSelected, item }: StatusPanelRowProps) => {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const primaryTextColor = isSelected ? selectedTextColor : colors.text;
	let statusColor = colors.textMuted;
	if (isSelected) {
		statusColor = selectedTextColor;
	} else if (item.status === "success") {
		statusColor = colors.success;
	} else if (item.status === "error" || item.status === "warning") {
		statusColor = colors.error;
	}

	return (
		<SelectableDialogItem>
			<box flexDirection="row" flexGrow={1} gap={1} marginRight={3}>
				<text
					attributes={isSelected ? TextAttributes.BOLD : undefined}
					fg={primaryTextColor}
					selectable={false}
					wrapMode="none"
				>
					{item.label}
				</text>
				<box flexGrow={1} />
				<text fg={statusColor} selectable={false} wrapMode="none">
					{isBusy ? "Working..." : statusLabel(item.status)}
				</text>
			</box>
		</SelectableDialogItem>
	);
};

export type PluginStatusPanelDialogContentProps = Readonly<{
	panel: PluginStatusPanelDescriptor;
	pluginRuntime: PluginRuntime;
}>;

/** Renders a Plugin's declarative status and routes actions through the Plugin Runtime. */
export const PluginStatusPanelDialogContent = ({
	panel,
	pluginRuntime,
}: PluginStatusPanelDialogContentProps) => {
	const toast = useToast();
	const { colors } = useTheme();
	const [snapshot, setSnapshot] = useState<PluginStatusPanelSnapshot>(() =>
		panel.getSnapshot()
	);
	const [selectedItemId, setSelectedItemId] = useState<string | undefined>(
		() => snapshot.items[0]?.id
	);
	const [busyItems, setBusyItems] = useState<ReadonlySet<string>>(
		() => new Set()
	);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const busyItemsRef = useRef(new Set<string>());
	const refreshingRef = useRef(false);
	const mountedRef = useRef(true);

	useDialogEscape();
	useEffect(() => {
		mountedRef.current = true;
		setSnapshot(panel.getSnapshot());
		const unsubscribe = panel.subscribe(() => {
			if (mountedRef.current) {
				setSnapshot(panel.getSnapshot());
			}
		});
		return () => {
			mountedRef.current = false;
			unsubscribe();
		};
	}, [panel]);

	const highlightItem = useCallback((item: PluginStatusItem) => {
		setSelectedItemId(item.id);
	}, []);
	const selectedItem =
		snapshot.items.find(({ id }) => id === selectedItemId) ?? snapshot.items[0];
	const selectedAction = selectedItem?.actions?.find(
		({ shortcut }) => shortcut === "space"
	);

	const refreshPanel = useCallback(() => {
		if (panel.refresh === undefined || refreshingRef.current) {
			return;
		}
		refreshingRef.current = true;
		setIsRefreshing(true);
		void pluginRuntime
			.refreshStatusPanel(panel.pluginId, panel.id)
			.then(() => {
				if (mountedRef.current) {
					setSnapshot(panel.getSnapshot());
				}
			})
			.catch(() => {
				if (mountedRef.current) {
					toast.show({
						message: `The ${panel.title} panel could not be refreshed.`,
						variant: "error",
					});
				}
			})
			.finally(() => {
				refreshingRef.current = false;
				if (mountedRef.current) {
					setIsRefreshing(false);
				}
			});
	}, [panel, pluginRuntime, toast.show]);

	const runAction = useCallback(
		(item: PluginStatusItem) => {
			const action = item.actions?.find(
				(candidate) => candidate.shortcut === "space"
			);
			if (action === undefined || busyItemsRef.current.has(item.id)) {
				return;
			}
			busyItemsRef.current.add(item.id);
			setBusyItems(new Set(busyItemsRef.current));
			void pluginRuntime
				.runStatusPanelAction(panel.pluginId, panel.id, item.id, action.id)
				.catch(() => {
					if (mountedRef.current) {
						toast.show({
							message: `The ${panel.title} action failed.`,
							variant: "error",
						});
					}
				})
				.finally(() => {
					busyItemsRef.current.delete(item.id);
					if (mountedRef.current) {
						setBusyItems(new Set(busyItemsRef.current));
					}
				});
		},
		[panel, pluginRuntime, toast.show]
	);

	return (
		<box flexDirection="column" gap={1}>
			<SearchListDialogWrapper<PluginStatusItem>
				emptyText={panel.emptyText ?? "No status items"}
				footer={
					<box flexDirection="row" gap={2} height={1} marginX={4}>
						<DialogFooterHint
							label={selectedAction?.label ?? "run action"}
							shortcut="space"
						/>
						{panel.refresh === undefined ? null : (
							<DialogFooterHint
								label={isRefreshing ? "refreshing…" : "refresh"}
								shortcut="ctrl+r"
							/>
						)}
					</box>
				}
				getKey={(item) => item.id}
				getSearchText={(item) =>
					[item.label, item.summary, item.detail, statusLabel(item.status)]
						.filter((value): value is string => !isUndefined(value))
						.join(" ")
				}
				items={snapshot.items}
				onHighlight={highlightItem}
				onKey={(key, highlightedItem) => {
					if (key.ctrl && key.name === "r" && panel.refresh !== undefined) {
						refreshPanel();
						return true;
					}
					if (
						key.name !== "space" ||
						isUndefined(highlightedItem) ||
						!highlightedItem.actions?.some(
							({ shortcut }) => shortcut === "space"
						)
					) {
						return false;
					}
					runAction(highlightedItem);
					return true;
				}}
				onSelect={() => undefined}
				placeholder="Search"
				renderItem={(item, isSelected) => (
					<StatusPanelRow
						isBusy={busyItems.has(item.id) || item.status === "pending"}
						isSelected={isSelected}
						item={item}
					/>
				)}
			/>
			{selectedItem?.summary === undefined &&
			selectedItem?.detail === undefined ? null : (
				<box flexDirection="column" gap={1} marginX={4}>
					{selectedItem.summary === undefined ? null : (
						<text fg={colors.textMuted} selectable={false} wrapMode="word">
							{selectedItem.summary}
						</text>
					)}
					{selectedItem.detail === undefined ? null : (
						<text fg={colors.textMuted} selectable={false} wrapMode="word">
							{selectedItem.detail}
						</text>
					)}
				</box>
			)}
		</box>
	);
};

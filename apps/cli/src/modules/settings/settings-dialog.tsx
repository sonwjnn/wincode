import { TextAttributes } from "@opentui/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogEscape } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import type {
	ResolvedSetting,
	SettingDescriptor,
	SettingResolution,
	SettingsOperations,
} from "./types";

export type SettingsDialogContentProps = {
	readonly initialSection?: string;
	readonly initialSettings?: readonly ResolvedSetting[];
	readonly operations: SettingsOperations;
};

type SettingsListItem =
	| { readonly id: string; readonly kind: "section"; readonly section: string }
	| {
			readonly id: string;
			readonly kind: "setting";
			readonly setting: ResolvedSetting;
	  };

type SettingMutation = () => Promise<ResolvedSetting>;

type SettingsValueMap = Record<string, unknown>;
type SettingsStateMap = Record<string, boolean | undefined>;
type SettingsErrorMap = Record<string, string | undefined>;
type SettingsVersionMap = Record<string, number | undefined>;
const getSettingResolution = (
	setting: ResolvedSetting
): SettingResolution<unknown> => ({
	available: setting.available,
	source: setting.source,
	...(setting.unavailableReason === undefined
		? {}
		: { unavailableReason: setting.unavailableReason }),
	value: setting.value,
});

const getValueLabel = (
	descriptor: SettingDescriptor,
	value: unknown
): string => {
	if (descriptor.kind === "boolean") {
		if (typeof value !== "boolean") {
			return "unknown";
		}
		return descriptor.formatValue?.(value) ?? (value ? "on" : "off");
	}
	if (descriptor.kind === "select") {
		const option = descriptor.options.find((entry) => entry.value === value);
		return option?.label ?? String(value);
	}
	return descriptor.formatValue?.(value) ?? String(value);
};

const getSourceLabel = (setting: ResolvedSetting): string => {
	switch (setting.source.kind) {
		case "config":
			return setting.source.scope === "global" ? "global" : "project override";
		case "default":
			return "default";
		case "runtime":
			return "runtime";
		case "session":
			return "session";
		default:
			return "unknown";
	}
};

const matchesSetting = (setting: ResolvedSetting, query: string): boolean => {
	const searchable = [
		setting.descriptor.description,
		setting.descriptor.id,
		setting.descriptor.label,
		setting.descriptor.section,
	]
		.join(" ")
		.toLowerCase();
	return searchable.includes(query.toLowerCase());
};

const buildItems = (
	settings: readonly ResolvedSetting[]
): SettingsListItem[] => {
	const items: SettingsListItem[] = [];
	let lastSection: string | undefined;
	for (const setting of settings) {
		const section = setting.descriptor.section;
		if (section !== lastSection) {
			items.push({
				id: `section:${section}`,
				kind: "section",
				section,
			});
			lastSection = section;
		}
		items.push({
			id: setting.descriptor.id,
			kind: "setting",
			setting,
		});
	}
	return items;
};

const getInitialSettingId = (
	settings: readonly ResolvedSetting[],
	section: string | undefined
): string | undefined =>
	settings.find(
		(setting) => section === undefined || setting.descriptor.section === section
	)?.descriptor.id;

const replaceSetting = (
	settings: readonly ResolvedSetting[],
	updated: ResolvedSetting
): readonly ResolvedSetting[] =>
	settings.map((setting) =>
		setting.descriptor.id === updated.descriptor.id ? updated : setting
	);

export function SettingsDialogContent({
	initialSection,
	initialSettings,
	operations,
}: SettingsDialogContentProps) {
	const { colors } = useTheme();
	const { show } = useToast();
	const [settings, setSettings] = useState<readonly ResolvedSetting[] | null>(
		() => initialSettings ?? null
	);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | undefined>(() =>
		initialSettings === undefined
			? undefined
			: getInitialSettingId(initialSettings, initialSection)
	);
	const [pendingById, setPendingById] = useState<SettingsStateMap>({});
	const [errorsById, setErrorsById] = useState<SettingsErrorMap>({});
	const intendedValuesRef = useRef<SettingsValueMap>({});
	const versionsRef = useRef<SettingsVersionMap>({});
	const initialSectionAppliedRef = useRef(false);
	const selectedTextColor = getContrastingTextColor(colors.selection);

	useDialogEscape();

	useEffect(() => {
		if (initialSettings !== undefined) {
			setSettings(initialSettings);
			return;
		}
		let active = true;
		const loadSettings = async (): Promise<void> => {
			try {
				const resolved = await operations.getSettings();
				if (active) {
					setSettings(resolved);
				}
			} catch (error: unknown) {
				if (!active) {
					return;
				}
				const message =
					error instanceof Error ? error.message : "Could not load settings.";
				setLoadError(message);
				show({ message, variant: "error" });
			}
		};
		void loadSettings();
		return () => {
			active = false;
		};
	}, [initialSettings, operations, show]);

	useEffect(() => {
		if (settings === null || initialSectionAppliedRef.current) {
			return;
		}
		setSelectedId(getInitialSettingId(settings, initialSection));
		initialSectionAppliedRef.current = true;
	}, [initialSection, settings]);

	const items = useMemo(
		() => (settings === null ? [] : buildItems(settings)),
		[settings]
	);
	const selectedSetting = settings?.find(
		(setting) => setting.descriptor.id === selectedId
	);
	const refreshSettingAfterFailure = useCallback(
		async (
			id: string,
			version: number,
			error: unknown
		): Promise<string | null> => {
			let message =
				error instanceof Error ? error.message : "Could not save setting.";
			try {
				const resolved = await operations.getSettings();
				if (versionsRef.current[id] !== version) {
					return null;
				}
				const persisted = resolved.find((entry) => entry.descriptor.id === id);
				if (persisted === undefined) {
					message = `${message} Could not refresh persisted setting.`;
				} else {
					setSettings((current) =>
						current === null ? current : replaceSetting(current, persisted)
					);
				}
			} catch (refreshError: unknown) {
				message =
					refreshError instanceof Error
						? `${message} Could not refresh persisted setting: ${refreshError.message}`
						: `${message} Could not refresh persisted setting.`;
			}
			return message;
		},
		[operations.getSettings]
	);

	const reportMutationFailure = useCallback(
		async (id: string, version: number, error: unknown): Promise<void> => {
			if (versionsRef.current[id] !== version) {
				return;
			}
			const message = await refreshSettingAfterFailure(id, version, error);
			if (message === null || versionsRef.current[id] !== version) {
				return;
			}
			show({ message, variant: "error" });
			delete intendedValuesRef.current[id];
			setErrorsById((current) => ({
				...current,
				[id]: message,
			}));
		},
		[refreshSettingAfterFailure, show]
	);

	const runMutation = useCallback(
		(
			setting: ResolvedSetting,
			mutation: SettingMutation,
			intended?: unknown
		) => {
			const id = setting.descriptor.id;
			const version = (versionsRef.current[id] ?? 0) + 1;
			versionsRef.current[id] = version;
			if (intended !== undefined) {
				intendedValuesRef.current[id] = intended;
			}
			setPendingById((current) => ({ ...current, [id]: true }));
			setErrorsById((current) => ({ ...current, [id]: undefined }));
			void (async () => {
				try {
					const updated = await mutation();
					if (versionsRef.current[id] !== version) {
						return;
					}
					setSettings((current) =>
						current === null ? current : replaceSetting(current, updated)
					);
					delete intendedValuesRef.current[id];
					setErrorsById((current) => ({ ...current, [id]: undefined }));
				} catch (error: unknown) {
					await reportMutationFailure(id, version, error);
				} finally {
					if (versionsRef.current[id] === version) {
						setPendingById((current) => ({ ...current, [id]: false }));
					}
				}
			})();
		},
		[reportMutationFailure]
	);

	const activateSetting = useCallback(
		(setting: ResolvedSetting) => {
			if (!setting.available) {
				return;
			}
			if (setting.descriptor.kind === "custom") {
				setting.descriptor.activate({
					onChange: (value) =>
						runMutation(
							setting,
							() => operations.setValue(setting.descriptor.id, value),
							value
						),
					onReset: () => {
						delete intendedValuesRef.current[setting.descriptor.id];
						runMutation(setting, () =>
							operations.resetValue(setting.descriptor.id)
						);
					},
					pending: pendingById[setting.descriptor.id] === true,
					resolution: getSettingResolution(setting),
				});
				return;
			}
			const current =
				intendedValuesRef.current[setting.descriptor.id] ?? setting.value;
			if (setting.descriptor.kind === "boolean") {
				if (typeof current !== "boolean") {
					return;
				}
				const next = !current;
				runMutation(
					setting,
					() => operations.setValue(setting.descriptor.id, next),
					next
				);
				return;
			}
			const optionIndex = setting.descriptor.options.findIndex(
				(option) => option.value === current
			);
			const nextOption =
				setting.descriptor.options[
					(optionIndex + 1) % setting.descriptor.options.length
				];
			if (nextOption === undefined) {
				return;
			}
			runMutation(
				setting,
				() => operations.setValue(setting.descriptor.id, nextOption.value),
				nextOption.value
			);
		},
		[operations, pendingById, runMutation]
	);

	const resetSetting = useCallback(
		(setting: ResolvedSetting) => {
			if (!setting.available) {
				return;
			}
			delete intendedValuesRef.current[setting.descriptor.id];
			runMutation(setting, () => operations.resetValue(setting.descriptor.id));
		},
		[operations, runMutation]
	);

	if (settings === null) {
		return (
			<box flexDirection="column" gap={1} marginX={4}>
				<text fg={loadError ? colors.error : colors.textMuted}>
					{loadError
						? `Could not load settings: ${loadError}`
						: "Loading settings…"}
				</text>
			</box>
		);
	}

	const selectedError = selectedSetting
		? errorsById[selectedSetting.descriptor.id]
		: undefined;
	return (
		<SearchListDialogWrapper
			emptyText={
				settings.length === 0
					? "No settings registered."
					: "No matching settings."
			}
			filterFn={(item, query) => {
				if (item.kind === "section") {
					return settings.some(
						(setting) =>
							setting.descriptor.section === item.section &&
							matchesSetting(setting, query)
					);
				}
				return matchesSetting(item.setting, query);
			}}
			footer={
				<box flexDirection="column" gap={1} marginX={4}>
					{selectedSetting ? (
						<>
							<text fg={colors.textMuted}>
								{selectedSetting.descriptor.description}
							</text>
							{selectedSetting.unavailableReason ? (
								<text fg={colors.error}>
									{selectedSetting.unavailableReason}
								</text>
							) : null}
							{pendingById[selectedSetting.descriptor.id] ? (
								<text fg={colors.textMuted}>Saving…</text>
							) : null}
							{selectedError ? (
								<text fg={colors.error}>{`Error: ${selectedError}`}</text>
							) : null}
						</>
					) : null}
					<box flexDirection="row" gap={2}>
						<DialogFooterHint label="navigate" shortcut="↑↓" />
						<DialogFooterHint label="change" shortcut="space/enter" />
						<DialogFooterHint label="reset" shortcut="ctrl+r" />
					</box>
				</box>
			}
			getKey={(item) => item.id}
			initialSelectedIndex={
				initialSection === undefined
					? undefined
					: Math.max(
							0,
							items.findIndex(
								(item) =>
									item.kind === "setting" &&
									item.setting.descriptor.section === initialSection
							)
						)
			}
			isItemSelectable={(item) =>
				item.kind === "setting" && item.setting.available
			}
			items={items}
			minVisibleItems={1}
			onHighlight={(item) => {
				if (item.kind === "setting") {
					setSelectedId(item.setting.descriptor.id);
				}
			}}
			onKey={(key, highlightedItem, isSearching) => {
				if (
					key.ctrl &&
					key.name === "r" &&
					highlightedItem?.kind === "setting"
				) {
					resetSetting(highlightedItem.setting);
					return true;
				}
				if (
					!isSearching &&
					key.name === "space" &&
					highlightedItem?.kind === "setting"
				) {
					activateSetting(highlightedItem.setting);
					return true;
				}
				return false;
			}}
			onSelect={(item) => {
				if (item.kind === "setting") {
					activateSetting(item.setting);
				}
			}}
			placeholder="Search settings"
			renderItem={(item, isSelected) => {
				if (item.kind === "section") {
					return (
						<SelectableDialogItem>
							<text fg={colors.primary}>{item.section}</text>
						</SelectableDialogItem>
					);
				}
				const setting = item.setting;
				const pending = pendingById[setting.descriptor.id] === true;
				if (setting.descriptor.kind === "custom") {
					return (
						<SelectableDialogItem>
							{setting.descriptor.render({
								onChange: (value) => {
									runMutation(
										setting,
										() => operations.setValue(setting.descriptor.id, value),
										value
									);
								},
								onReset: () => resetSetting(setting),
								pending,
								resolution: getSettingResolution(setting),
							})}
						</SelectableDialogItem>
					);
				}
				const value = getValueLabel(setting.descriptor, setting.value);
				const displayedValue = setting.available
					? value
					: `unavailable — ${setting.unavailableReason ?? "not available"}`;
				const intended = intendedValuesRef.current[setting.descriptor.id];
				let pendingValue = "";
				if (pending) {
					pendingValue =
						intended === undefined
							? " (saving…)"
							: ` → ${getValueLabel(setting.descriptor, intended)} (saving…)`;
				}
				let foregroundColor = colors.textMuted;
				if (setting.available) {
					foregroundColor = isSelected ? selectedTextColor : colors.text;
				}
				return (
					<SelectableDialogItem>
						<text
							attributes={isSelected ? TextAttributes.BOLD : undefined}
							fg={foregroundColor}
							selectable={false}
						>
							{`${setting.descriptor.label}: ${displayedValue}${pendingValue} (${getSourceLabel(setting)})`}
						</text>
					</SelectableDialogItem>
				);
			}}
			showSearch
		/>
	);
}

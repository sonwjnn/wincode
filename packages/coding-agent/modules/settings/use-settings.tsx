import { useCallback, useMemo } from "react";
import { useConfig } from "@/shared/config/config-provider";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useCopyOnSelectSettings } from "./copy-on-select-settings";
import { useHideThinkingSettings } from "./hide-thinking-settings";
import { createSettingsOperations } from "./operations";
import { SettingsDialogContent } from "./settings-dialog";
import type { SettingRuntimeContext, SettingsOperations } from "./types";

const EMPTY_SETTING_RUNTIME_CONTEXT: SettingRuntimeContext = {};

const SETTINGS_DIALOG_WIDTH = 60;

export function useSettingsOperations(
	runtime: SettingRuntimeContext = EMPTY_SETTING_RUNTIME_CONTEXT
): SettingsOperations {
	const config = useConfig();
	const copyOnSelectSettings = useCopyOnSelectSettings();
	const hideThinkingSettings = useHideThinkingSettings();
	return useMemo(
		() =>
			createSettingsOperations({
				configStore: config.configStore,
				runtime: {
					...runtime,
					onCopyOnSelectChanged: (enabled) => {
						runtime.onCopyOnSelectChanged?.(enabled);
						copyOnSelectSettings?.setEnabled(enabled);
					},
					onHideThinkingChanged: (hidden) => {
						runtime.onHideThinkingChanged?.(hidden);
						hideThinkingSettings?.setHidden(hidden);
					},
				},
				workspace: config.workspace,
			}),
		[
			config.configStore,
			config.workspace,
			copyOnSelectSettings?.setEnabled,
			hideThinkingSettings?.setHidden,
			runtime,
		]
	);
}

export function useSettingsHubDialog(
	runtime?: SettingRuntimeContext
): (initialSection?: string) => void {
	const operations = useSettingsOperations(runtime);
	const dialog = useDialog();
	return useCallback(
		(initialSection?: string) => {
			dialog.open({
				children: (
					<SettingsDialogContent
						initialSection={initialSection}
						operations={operations}
					/>
				),
				padding: { bottom: 1, left: 0, right: 0, top: 1 },
				title: "Settings",
				titleMargin: { left: 4, right: 4 },
				width: SETTINGS_DIALOG_WIDTH,
			});
		},
		[dialog, operations]
	);
}

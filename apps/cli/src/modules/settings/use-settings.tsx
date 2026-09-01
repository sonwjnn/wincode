import { useCallback, useMemo } from "react";
import { useConfig } from "@/shared/config/config-provider";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { createSettingsOperations } from "./operations";
import { SettingsDialogContent } from "./settings-dialog";
import type { SettingRuntimeContext, SettingsOperations } from "./types";

const EMPTY_SETTING_RUNTIME_CONTEXT: SettingRuntimeContext = {};

export function useSettingsOperations(
	runtime: SettingRuntimeContext = EMPTY_SETTING_RUNTIME_CONTEXT
): SettingsOperations {
	const config = useConfig();
	return useMemo(
		() =>
			createSettingsOperations({
				configStore: config.configStore,
				runtime,
				workspace: config.workspace,
			}),
		[config.configStore, config.workspace, runtime]
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
			});
		},
		[dialog, operations]
	);
}

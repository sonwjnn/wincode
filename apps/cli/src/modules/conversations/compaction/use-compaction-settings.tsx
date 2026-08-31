import type { ChatModelSelection } from "@wincode/ai";
import { useCallback, useMemo } from "react";
import {
	type ModelPricingTable,
	useModelPricing,
} from "@/modules/model-pricing";
import { useConfig } from "@/shared/config/config-provider";
import type { ConfigStore } from "@/shared/config/config-store";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { CompactionSettingsDialogContent } from "./compaction-settings-dialog";
import {
	type CompactionSettingKey,
	type CompactionSettings,
	getCompactionSettingSource,
	type ResolvedCompactionSettings,
	resolveCompactionSettingPath,
	resolveCompactionSettings,
} from "./config";

export type CompactionSettingsOperations = {
	getCompactionSettings: (
		model: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	persistCompactionSetting: (
		model: ChatModelSelection,
		key: CompactionSettingKey,
		value: CompactionSettings[CompactionSettingKey]
	) => Promise<void>;
	resetCompactionSetting: (
		model: ChatModelSelection,
		key: CompactionSettingKey
	) => Promise<CompactionSettings[CompactionSettingKey]>;
};

type CompactionSettingsDependencies = {
	configStore: ConfigStore;
	pricing: ModelPricingTable;
	workspace: string;
};

export const createCompactionSettingsOperations = ({
	configStore,
	pricing,
	workspace,
}: CompactionSettingsDependencies): CompactionSettingsOperations => {
	const getCompactionSettings = async (
		model: ChatModelSelection
	): Promise<ResolvedCompactionSettings> => {
		const snapshot = await configStore
			.getSnapshot(workspace)
			.catch(() => undefined);
		return resolveCompactionSettings({ model, pricing, snapshot });
	};

	const persistCompactionSetting = async (
		model: ChatModelSelection,
		key: CompactionSettingKey,
		value: CompactionSettings[CompactionSettingKey]
	): Promise<void> => {
		const settings = await getCompactionSettings(model);
		const source = getCompactionSettingSource(settings, key);
		const scope = source.kind === "config" ? source.scope : "project";
		await configStore.setValue(
			workspace,
			scope,
			resolveCompactionSettingPath(settings, key),
			value
		);
	};

	const resetCompactionSetting = async (
		model: ChatModelSelection,
		key: CompactionSettingKey
	): Promise<CompactionSettings[CompactionSettingKey]> => {
		const settings = await getCompactionSettings(model);
		const source = getCompactionSettingSource(settings, key);
		const scope = source.kind === "config" ? source.scope : "project";
		await configStore.setValue(
			workspace,
			scope,
			resolveCompactionSettingPath(settings, key),
			undefined
		);
		const refreshed = await getCompactionSettings(model);
		return refreshed.resolved[key];
	};

	return {
		getCompactionSettings,
		persistCompactionSetting,
		resetCompactionSetting,
	};
};

export function useCompactionSettings(): CompactionSettingsOperations {
	const config = useConfig();
	const { table: pricing } = useModelPricing();
	return useMemo(
		() =>
			createCompactionSettingsOperations({
				configStore: config.configStore,
				pricing,
				workspace: config.workspace,
			}),
		[config.configStore, config.workspace, pricing]
	);
}

export function useCompactionSettingsDialog(): (
	model: ChatModelSelection
) => Promise<void> {
	const {
		getCompactionSettings,
		persistCompactionSetting,
		resetCompactionSetting,
	} = useCompactionSettings();
	const dialog = useDialog();
	const { show } = useToast();

	return useCallback(
		async (model: ChatModelSelection): Promise<void> => {
			try {
				const settings = await getCompactionSettings(model);
				const updateCompactionSetting = async (
					key: "auto",
					value: boolean
				): Promise<void> => {
					try {
						await persistCompactionSetting(model, key, value);
					} catch (error) {
						show({
							message:
								error instanceof Error
									? error.message
									: "Could not save compaction settings.",
							variant: "error",
						});
						throw error;
					}
				};
				const resetCompactionSettings = async (): Promise<
					boolean | undefined
				> => {
					try {
						const value = await resetCompactionSetting(model, "auto");
						return typeof value === "boolean" ? value : undefined;
					} catch (error) {
						show({
							message:
								error instanceof Error
									? error.message
									: "Could not reset compaction settings.",
							variant: "error",
						});
						return;
					}
				};
				dialog.open({
					children: (
						<CompactionSettingsDialogContent
							onChange={updateCompactionSetting}
							onReset={resetCompactionSettings}
							settings={settings}
						/>
					),
					padding: { bottom: 1, left: 0, right: 0, top: 1 },
					title: "Compaction Settings",
					titleMargin: { left: 4, right: 4 },
				});
			} catch (error) {
				show({
					message:
						error instanceof Error
							? error.message
							: "Could not load compaction settings.",
					variant: "error",
				});
			}
		},
		[
			dialog,
			getCompactionSettings,
			persistCompactionSetting,
			resetCompactionSetting,
			show,
		]
	);
}

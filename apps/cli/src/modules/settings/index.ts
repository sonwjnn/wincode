export {
	AUTO_COMPACT_GLOBAL_PATH,
	AUTO_COMPACT_SETTING,
	AUTO_COMPACT_SETTING_ID,
	SETTINGS_CATALOG,
} from "./catalog";
export {
	createSettingsOperations,
	type SettingsOperationsDependencies,
} from "./operations";
export type { SettingsDialogContentProps } from "./settings-dialog";
export { SettingsDialogContent } from "./settings-dialog";
export type {
	BooleanSettingDescriptor,
	CustomSettingDescriptor,
	ResolvedSetting,
	SelectSettingDescriptor,
	SettingContextRequirement,
	SettingDescriptor,
	SettingKind,
	SettingOperationContext,
	SettingPersistence,
	SettingRendererProps,
	SettingResolution,
	SettingRuntimeContext,
	SettingScope,
	SettingSource,
	SettingsCatalog,
	SettingsOperations,
} from "./types";
export { useSettingsHubDialog, useSettingsOperations } from "./use-settings";

import type { CopyOnSelectProps } from "@/shared/clipboard/copy-on-select";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { COPY_ON_SELECT_SETTING } from "./catalog";
import { createGlobalBooleanPreferenceContext } from "./global-boolean-preference";

export type CopyOnSelectSettingsState = {
	readonly enabled: boolean | null;
	readonly setEnabled: (enabled: boolean) => void;
};

const copyOnSelectSettings = createGlobalBooleanPreferenceContext(
	COPY_ON_SELECT_SETTING,
	true,
	({ value, setValue }): CopyOnSelectSettingsState => ({
		enabled: value,
		setEnabled: setValue,
	})
);

export const CopyOnSelectSettingsProvider = copyOnSelectSettings.Provider;

export function CopyOnSelectFromSettings({
	write,
}: Pick<CopyOnSelectProps, "write">) {
	const settings = useCopyOnSelectSettings();
	if (settings === null || settings.enabled === null) {
		return null;
	}
	return <CopyOnSelect enabled={settings.enabled} write={write} />;
}

export const useCopyOnSelectSettings = copyOnSelectSettings.usePreference;

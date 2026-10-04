import { HIDE_THINKING_SETTING } from "./catalog";
import { createGlobalBooleanPreferenceContext } from "./global-boolean-preference";

export type HideThinkingSettingsState = {
	readonly hidden: boolean | null;
	readonly setHidden: (hidden: boolean) => void;
};

const hideThinkingSettings = createGlobalBooleanPreferenceContext(
	HIDE_THINKING_SETTING,
	false,
	({ value, setValue }): HideThinkingSettingsState => ({
		hidden: value,
		setHidden: setValue,
	})
);

export const HideThinkingSettingsProvider = hideThinkingSettings.Provider;
export const useHideThinkingSettings = hideThinkingSettings.usePreference;

export function useHideThinking(): boolean {
	const settings = useHideThinkingSettings();
	return settings?.hidden ?? false;
}

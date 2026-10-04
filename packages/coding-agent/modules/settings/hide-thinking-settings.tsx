import { HIDE_THINKING_SETTING_ID } from "./catalog";
import { useGlobalBooleanPreference } from "./global-boolean-preference";

export function useHideThinking(): boolean {
	return useGlobalBooleanPreference(HIDE_THINKING_SETTING_ID) ?? false;
}

import { HIDE_THINKING_SETTING } from "./catalog";
import { useSettingRegistryValue } from "./settings-registry";

export function useHideThinking(): boolean {
	const setting = useSettingRegistryValue(HIDE_THINKING_SETTING);
	return setting.status === "ready" ? setting.value : false;
}

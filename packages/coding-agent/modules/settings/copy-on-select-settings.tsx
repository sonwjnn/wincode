import { CopyOnSelect } from "@/shared/clipboard";
import { COPY_ON_SELECT_SETTING } from "./catalog";
import { useSettingRegistryValue } from "./settings-registry";

export function CopyOnSelectFromSettings() {
	const setting = useSettingRegistryValue(COPY_ON_SELECT_SETTING);
	if (setting.status !== "ready") {
		return null;
	}
	return <CopyOnSelect enabled={setting.value} />;
}

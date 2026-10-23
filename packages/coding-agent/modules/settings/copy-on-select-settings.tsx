import { CopyOnSelect } from "@/shared/clipboard";
import { isCopyBehavior } from "@/shared/clipboard/copy-behavior";
import { COPY_BEHAVIOR_SETTING } from "./catalog";
import { useSettingRegistryValue } from "./settings-registry";

export function CopyOnSelectFromSettings() {
	const setting = useSettingRegistryValue(COPY_BEHAVIOR_SETTING);
	if (setting.status !== "ready" || !isCopyBehavior(setting.value)) {
		return null;
	}
	return <CopyOnSelect behavior={setting.value} />;
}

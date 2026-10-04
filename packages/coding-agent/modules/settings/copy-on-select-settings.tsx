import type { CopyOnSelectProps } from "@/shared/clipboard/copy-on-select";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { COPY_ON_SELECT_SETTING } from "./catalog";
import { useSettingRegistryValue } from "./settings-registry";

export function CopyOnSelectFromSettings({
	write,
}: Pick<CopyOnSelectProps, "write">) {
	const setting = useSettingRegistryValue(COPY_ON_SELECT_SETTING);
	if (setting.status !== "ready") {
		return null;
	}
	return <CopyOnSelect enabled={setting.value} write={write} />;
}

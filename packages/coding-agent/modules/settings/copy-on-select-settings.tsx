import type { CopyOnSelectProps } from "@/shared/clipboard/copy-on-select";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { COPY_ON_SELECT_SETTING_ID } from "./catalog";
import { useGlobalBooleanPreference } from "./global-boolean-preference";

export function CopyOnSelectFromSettings({
	write,
}: Pick<CopyOnSelectProps, "write">) {
	const enabled = useGlobalBooleanPreference(COPY_ON_SELECT_SETTING_ID);
	if (enabled === null) {
		return null;
	}
	return <CopyOnSelect enabled={enabled} write={write} />;
}

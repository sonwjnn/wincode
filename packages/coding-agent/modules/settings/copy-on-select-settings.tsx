import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { CopyOnSelectProps } from "@/shared/clipboard/copy-on-select";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { COPY_ON_SELECT_SETTING } from "./catalog";
import { useGlobalBooleanPreference } from "./global-boolean-preference";

export type CopyOnSelectSettingsState = {
	readonly enabled: boolean | null;
	readonly setEnabled: (enabled: boolean) => void;
};

const CopyOnSelectSettingsContext =
	createContext<CopyOnSelectSettingsState | null>(null);

export function CopyOnSelectSettingsProvider({
	children,
}: {
	children: ReactNode;
}) {
	const { value: enabled, setValue: setEnabled } = useGlobalBooleanPreference(
		COPY_ON_SELECT_SETTING,
		true
	);

	return (
		<CopyOnSelectSettingsContext.Provider value={{ enabled, setEnabled }}>
			{children}
		</CopyOnSelectSettingsContext.Provider>
	);
}

export function CopyOnSelectFromSettings({
	write,
}: Pick<CopyOnSelectProps, "write">) {
	const settings = useCopyOnSelectSettings();
	if (settings === null || settings.enabled === null) {
		return null;
	}
	return <CopyOnSelect enabled={settings.enabled} write={write} />;
}

export function useCopyOnSelectSettings(): CopyOnSelectSettingsState | null {
	return useContext(CopyOnSelectSettingsContext);
}

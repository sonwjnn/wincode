import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import { HIDE_THINKING_SETTING } from "./catalog";
import { useGlobalBooleanPreference } from "./global-boolean-preference";

export type HideThinkingSettingsState = {
	readonly hidden: boolean | null;
	readonly setHidden: (hidden: boolean) => void;
};

const HideThinkingSettingsContext =
	createContext<HideThinkingSettingsState | null>(null);

export function HideThinkingSettingsProvider({
	children,
}: {
	children: ReactNode;
}) {
	const { value: hidden, setValue: setHidden } = useGlobalBooleanPreference(
		HIDE_THINKING_SETTING,
		false
	);

	return (
		<HideThinkingSettingsContext.Provider value={{ hidden, setHidden }}>
			{children}
		</HideThinkingSettingsContext.Provider>
	);
}

export function useHideThinkingSettings(): HideThinkingSettingsState | null {
	return useContext(HideThinkingSettingsContext);
}

export function useHideThinking(): boolean {
	const settings = useHideThinkingSettings();
	return settings?.hidden ?? false;
}

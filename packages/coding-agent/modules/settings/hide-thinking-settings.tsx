import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { useConfig } from "@/shared/config/config-provider";
import { HIDE_THINKING_SETTING } from "./catalog";

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
	const { configStore, workspace } = useConfig();
	const [hidden, setHidden] = useState<boolean | null>(null);

	useEffect(() => {
		let active = true;
		const loadPreference = async (): Promise<void> => {
			try {
				const snapshot = await configStore.getSnapshot(workspace);
				if (active) {
					setHidden(
						(current) =>
							current ?? HIDE_THINKING_SETTING.read(snapshot, {}).value
					);
				}
			} catch {
				if (active) {
					setHidden((current) => current ?? false);
				}
			}
		};
		void loadPreference();
		return () => {
			active = false;
		};
	}, [configStore, workspace]);

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
	return settings === null ? false : (settings.hidden ?? true);
}

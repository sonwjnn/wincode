import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import type { CopyOnSelectProps } from "@/shared/clipboard/copy-on-select";
import { CopyOnSelect } from "@/shared/clipboard/copy-on-select";
import { useConfig } from "@/shared/config/config-provider";
import { COPY_ON_SELECT_SETTING } from "./catalog";

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
	const { configStore, workspace } = useConfig();
	const [enabled, setEnabled] = useState<boolean | null>(null);

	useEffect(() => {
		let active = true;
		const loadPreference = async (): Promise<void> => {
			try {
				const snapshot = await configStore.getSnapshot(workspace);
				if (active) {
					setEnabled(COPY_ON_SELECT_SETTING.read(snapshot, {}).value);
				}
			} catch {
				if (active) {
					setEnabled(true);
				}
			}
		};
		void loadPreference();
		return () => {
			active = false;
		};
	}, [configStore, workspace]);

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

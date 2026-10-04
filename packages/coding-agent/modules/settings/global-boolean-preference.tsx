import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { useConfig } from "@/shared/config/config-provider";
import type { BooleanSettingDescriptor } from "./types";

export type GlobalBooleanPreferenceState = {
	readonly value: boolean | null;
	readonly setValue: (value: boolean) => void;
};

export function useGlobalBooleanPreference(
	descriptor: BooleanSettingDescriptor,
	fallback: boolean
): GlobalBooleanPreferenceState {
	const { configStore, workspace } = useConfig();
	const [value, setValue] = useState<boolean | null>(null);

	useEffect(() => {
		let active = true;
		const loadPreference = async (): Promise<void> => {
			try {
				const snapshot = await configStore.getSnapshot(workspace);
				if (active) {
					setValue((current) => current ?? descriptor.read(snapshot, {}).value);
				}
			} catch {
				if (active) {
					setValue((current) => current ?? fallback);
				}
			}
		};
		void loadPreference();
		return () => {
			active = false;
		};
	}, [configStore, descriptor, fallback, workspace]);

	return { value, setValue };
}

export function createGlobalBooleanPreferenceContext<State>(
	descriptor: BooleanSettingDescriptor,
	fallback: boolean,
	mapState: (state: GlobalBooleanPreferenceState) => State
) {
	const Context = createContext<State | null>(null);

	function Provider({ children }: { children: ReactNode }) {
		const state = useGlobalBooleanPreference(descriptor, fallback);
		return (
			<Context.Provider value={mapState(state)}>{children}</Context.Provider>
		);
	}

	function usePreference(): State | null {
		return useContext(Context);
	}

	return { Provider, usePreference };
}

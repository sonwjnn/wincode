import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { useConfig } from "@/shared/config/config-provider";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { SETTINGS_CATALOG } from "./catalog";
import type { GlobalBooleanPreferenceDescriptor } from "./types";

type CatalogPreference = Extract<
	(typeof SETTINGS_CATALOG)[number],
	GlobalBooleanPreferenceDescriptor
>;

export type GlobalBooleanPreferenceId = CatalogPreference["id"];

type GlobalBooleanPreferenceRegistry = {
	readonly get: (id: GlobalBooleanPreferenceId) => boolean | null;
	readonly publish: (id: string, value: boolean) => void;
	readonly subscribe: (
		id: GlobalBooleanPreferenceId,
		listener: () => void
	) => () => void;
};

type PreferenceRegistry = GlobalBooleanPreferenceRegistry & {
	readonly initialize: (id: GlobalBooleanPreferenceId, value: boolean) => void;
};

const GlobalBooleanPreferenceRegistryContext =
	createContext<GlobalBooleanPreferenceRegistry | null>(null);

const GLOBAL_BOOLEAN_PREFERENCES = SETTINGS_CATALOG.filter(
	(setting): setting is CatalogPreference =>
		setting.kind === "boolean" && "globalPreference" in setting
);

const getPreferenceValue = (
	preference: CatalogPreference,
	snapshot?: ConfigSnapshot
): boolean => {
	if (snapshot === undefined) {
		return preference.globalPreference.defaultValue;
	}
	try {
		return preference.read(snapshot, {}).value;
	} catch {
		return preference.globalPreference.defaultValue;
	}
};

const initializePreferences = (
	registry: PreferenceRegistry,
	snapshot?: ConfigSnapshot
): void => {
	for (const preference of GLOBAL_BOOLEAN_PREFERENCES) {
		registry.initialize(
			preference.id,
			getPreferenceValue(preference, snapshot)
		);
	}
};

const createPreferenceRegistry = (): PreferenceRegistry => {
	const values = new Map<string, boolean | null>();
	const listeners = new Map<string, Set<() => void>>();
	for (const preference of GLOBAL_BOOLEAN_PREFERENCES) {
		values.set(preference.id, null);
	}

	const publish = (id: string, value: boolean): void => {
		const current = values.get(id);
		if (current === undefined || current === value) {
			return;
		}
		values.set(id, value);
		for (const listener of listeners.get(id) ?? []) {
			listener();
		}
	};

	return {
		get: (id) => values.get(id) ?? null,
		initialize: (id, value) => {
			if (values.get(id) === null) {
				publish(id, value);
			}
		},
		publish,
		subscribe: (id, listener) => {
			let subscribers = listeners.get(id);
			if (subscribers === undefined) {
				subscribers = new Set();
				listeners.set(id, subscribers);
			}
			subscribers.add(listener);
			return () => {
				subscribers.delete(listener);
				if (subscribers.size === 0) {
					listeners.delete(id);
				}
			};
		},
	};
};

export function GlobalBooleanPreferencesProvider({
	children,
}: {
	children: ReactNode;
}) {
	const { configStore, workspace } = useConfig();
	const [registry] = useState(() => createPreferenceRegistry());

	useEffect(() => {
		let active = true;
		const loadPreferences = async (): Promise<void> => {
			try {
				const snapshot = await configStore.getSnapshot(workspace);
				if (active) {
					initializePreferences(registry, snapshot);
				}
			} catch {
				if (active) {
					initializePreferences(registry);
				}
			}
		};

		void loadPreferences();
		return () => {
			active = false;
		};
	}, [configStore, registry, workspace]);

	return (
		<GlobalBooleanPreferenceRegistryContext.Provider value={registry}>
			{children}
		</GlobalBooleanPreferenceRegistryContext.Provider>
	);
}

export function useGlobalBooleanPreferenceRegistry(): GlobalBooleanPreferenceRegistry | null {
	return useContext(GlobalBooleanPreferenceRegistryContext);
}

export function useGlobalBooleanPreference(
	id: GlobalBooleanPreferenceId
): boolean | null {
	const registry = useGlobalBooleanPreferenceRegistry();
	const subscribe = useCallback(
		(listener: () => void) =>
			registry?.subscribe(id, listener) ?? (() => undefined),
		[id, registry]
	);
	const getSnapshot = useCallback(
		() => registry?.get(id) ?? null,
		[id, registry]
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

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
import {
	isRegisteredSettingDescriptor,
	type RegisteredSettingDescriptor,
	type SettingRegistryItem,
	type SettingsRegistryMetadata,
} from "./types";

export type SettingsRegistryState<Value> =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly value: Value }
	| { readonly status: "unavailable" };

type SettingsRegistrySnapshot = SettingsRegistryState<unknown>;
type SettingsRegistryDefinition = {
	readonly id: string;
	readonly registry: SettingsRegistryMetadata<unknown>;
	readonly validate: (value: unknown) => boolean;
};

export type SettingsRegistry = {
	get<Value>(item: SettingRegistryItem<Value>): SettingsRegistryState<Value>;
	initialize: (id: string, value: unknown) => void;
	publish: (id: string, value: unknown) => void;
	subscribe: (id: string, listener: () => void) => () => void;
};

const LOADING = { status: "loading" } as const;
const UNAVAILABLE = { status: "unavailable" } as const;
const SettingsRegistryContext = createContext<SettingsRegistry | null>(null);

const REGISTERED_SETTINGS = SETTINGS_CATALOG.filter(
	isRegisteredSettingDescriptor
);

const readSettingValue = (
	descriptor: RegisteredSettingDescriptor,
	snapshot?: ConfigSnapshot
): unknown => {
	if (snapshot === undefined) {
		return descriptor.registry.defaultValue;
	}
	try {
		const resolution = descriptor.read(snapshot, {});
		return resolution.available && descriptor.validate(resolution.value)
			? resolution.value
			: descriptor.registry.defaultValue;
	} catch {
		return descriptor.registry.defaultValue;
	}
};

const initializeSettings = (
	registry: SettingsRegistry,
	snapshot?: ConfigSnapshot
): void => {
	for (const descriptor of REGISTERED_SETTINGS) {
		registry.initialize(descriptor.id, readSettingValue(descriptor, snapshot));
	}
};

export function createSettingsRegistry(
	descriptors: readonly SettingsRegistryDefinition[]
): SettingsRegistry {
	const descriptorsById = new Map<string, SettingsRegistryDefinition>();
	const values = new Map<string, SettingsRegistrySnapshot>();
	const listeners = new Map<string, Set<() => void>>();

	for (const descriptor of descriptors) {
		descriptorsById.set(descriptor.id, descriptor);
		values.set(descriptor.id, LOADING);
	}

	const notify = (id: string): void => {
		const settingListeners = listeners.get(id);
		if (settingListeners === undefined) {
			return;
		}
		for (const listener of settingListeners) {
			listener();
		}
	};

	const storeValue = (
		descriptor: SettingsRegistryDefinition,
		value: unknown
	): void => {
		const current = values.get(descriptor.id);
		if (current?.status === "ready" && Object.is(current.value, value)) {
			return;
		}
		values.set(descriptor.id, { status: "ready", value });
		notify(descriptor.id);
	};

	function get<Value>(
		item: SettingRegistryItem<Value>
	): SettingsRegistryState<Value> {
		const state = values.get(item.id) ?? UNAVAILABLE;
		if (state.status === "ready" && !item.validate(state.value)) {
			return UNAVAILABLE;
		}
		return state as SettingsRegistryState<Value>;
	}

	return {
		get,
		initialize: (id, value) => {
			const descriptor = descriptorsById.get(id);
			if (descriptor === undefined || values.get(id)?.status !== "loading") {
				return;
			}
			const initialValue = descriptor.validate(value)
				? value
				: descriptor.registry.defaultValue;
			storeValue(descriptor, initialValue);
		},
		publish: (id, value) => {
			const descriptor = descriptorsById.get(id);
			if (descriptor === undefined || !descriptor.validate(value)) {
				return;
			}
			storeValue(descriptor, value);
		},
		subscribe: (id, listener) => {
			let settingListeners = listeners.get(id);
			if (settingListeners === undefined) {
				settingListeners = new Set();
				listeners.set(id, settingListeners);
			}
			settingListeners.add(listener);
			return () => {
				settingListeners.delete(listener);
				if (settingListeners.size === 0) {
					listeners.delete(id);
				}
			};
		},
	};
}

export function SettingsRegistryProvider({
	children,
}: {
	children: ReactNode;
}) {
	const { configStore, workspace } = useConfig();
	const [registry] = useState(() =>
		createSettingsRegistry(REGISTERED_SETTINGS)
	);

	useEffect(() => {
		let active = true;
		const loadSettings = async (): Promise<void> => {
			try {
				const snapshot = await configStore.getSnapshot(workspace);
				if (active) {
					initializeSettings(registry, snapshot);
				}
			} catch {
				if (active) {
					initializeSettings(registry);
				}
			}
		};

		void loadSettings();
		return () => {
			active = false;
		};
	}, [configStore, registry, workspace]);

	return (
		<SettingsRegistryContext.Provider value={registry}>
			{children}
		</SettingsRegistryContext.Provider>
	);
}

export function useSettingsRegistry(): SettingsRegistry | null {
	return useContext(SettingsRegistryContext);
}

export function useSettingRegistryValue<Value>(
	item: SettingRegistryItem<Value>
): SettingsRegistryState<Value> {
	const registry = useSettingsRegistry();
	const subscribe = useCallback(
		(listener: () => void) =>
			registry?.subscribe(item.id, listener) ?? (() => undefined),
		[item.id, registry]
	);
	const getSnapshot = useCallback(
		() => registry?.get(item) ?? UNAVAILABLE,
		[item, registry]
	);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

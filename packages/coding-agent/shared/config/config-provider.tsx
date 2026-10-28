import { isNull } from "@wincode/utils";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useSyncExternalStore,
} from "react";
import type { ConfigRuntime, ConfigSnapshot } from "./config-store";

type ConfigContextValue = ConfigRuntime & {
	readonly snapshot: ConfigSnapshot | undefined;
};

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({
	children,
	value,
}: {
	children: ReactNode;
	value: ConfigRuntime;
}) {
	const { configStore, workspace } = value;
	const subscribe = useCallback(
		(listener: () => void) =>
			configStore.subscribeSnapshot(workspace, listener),
		[configStore, workspace]
	);
	const readSnapshot = useCallback(
		() => configStore.readSnapshot(workspace),
		[configStore, workspace]
	);
	const snapshot = useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
	const resolved = useMemo(
		() => ({
			...value,
			snapshot,
		}),
		[value, snapshot]
	);
	return (
		<ConfigContext.Provider value={resolved}>{children}</ConfigContext.Provider>
	);
}

export function useConfig(): ConfigContextValue {
	const value = useContext(ConfigContext);
	if (isNull(value)) {
		throw new Error("useConfig must be used within a ConfigProvider");
	}
	return value;
}

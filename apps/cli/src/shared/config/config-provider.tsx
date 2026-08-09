import { createContext, type ReactNode, useContext } from "react";
import type { ConfigRuntime } from "./config-store";

const ConfigContext = createContext<ConfigRuntime | null>(null);

export function ConfigProvider({
	children,
	value,
}: {
	children: ReactNode;
	value: ConfigRuntime;
}) {
	return (
		<ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
	);
}

export function useConfig(): ConfigRuntime {
	const value = useContext(ConfigContext);
	if (value === null) {
		throw new Error("useConfig must be used within a ConfigProvider");
	}
	return value;
}

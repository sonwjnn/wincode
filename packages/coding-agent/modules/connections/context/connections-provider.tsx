import type { Connections } from "@wincode/ai/connections";
import { isNull } from "@wincode/runtime-utils";
import type { ReactNode } from "react";
import { createContext, useContext, useRef } from "react";

type ConnectionsProviderProps = {
	children: ReactNode;
	connections: Connections;
};

const ConnectionsContext = createContext<Connections | null>(null);

export function ConnectionsProvider({
	children,
	connections,
}: ConnectionsProviderProps) {
	const connectionsRef = useRef<Connections | null>(null);

	if (isNull(connectionsRef.current)) {
		connectionsRef.current = connections;
	}

	return (
		<ConnectionsContext.Provider value={connectionsRef.current}>
			{children}
		</ConnectionsContext.Provider>
	);
}

export function useConnections(): Connections {
	const context = useContext(ConnectionsContext);

	if (isNull(context)) {
		throw new Error("useConnections must be used within a ConnectionsProvider");
	}

	return context;
}

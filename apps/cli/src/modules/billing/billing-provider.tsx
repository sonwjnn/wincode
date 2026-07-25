import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useConnections } from "@/modules/connections";
import { type BillingUsage, getBillingUsage } from "./api/get-billing-usage";

export type BillingState =
	| { status: "idle" | "loading" | "unavailable"; usage: null }
	| { status: "ready"; usage: BillingUsage };

type BillingContextValue = BillingState & {
	refresh: () => Promise<void>;
};

const BillingContext = createContext<BillingContextValue | null>(null);

type BillingProviderProps = {
	children: ReactNode;
	enabled: boolean;
};

export function BillingProvider({ children, enabled }: BillingProviderProps) {
	const connections = useConnections();
	const requestIdRef = useRef(0);
	const [state, setState] = useState<BillingState>({
		status: enabled ? "loading" : "idle",
		usage: null,
	});

	const refresh = useCallback(async (): Promise<void> => {
		const requestId = requestIdRef.current + 1;
		requestIdRef.current = requestId;
		if (!enabled) {
			setState({ status: "idle", usage: null });
			return;
		}

		setState((current) =>
			current.status === "ready" ? current : { status: "loading", usage: null }
		);
		try {
			const usage = await getBillingUsage(connections);
			if (requestIdRef.current === requestId) {
				setState({ status: "ready", usage });
			}
		} catch {
			if (requestIdRef.current === requestId) {
				setState({ status: "unavailable", usage: null });
			}
		}
	}, [connections, enabled]);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	const value = useMemo(() => ({ ...state, refresh }), [refresh, state]);

	return (
		<BillingContext.Provider value={value}>{children}</BillingContext.Provider>
	);
}

export function useBilling(): BillingContextValue {
	const context = useContext(BillingContext);
	if (context === null) {
		throw new Error("useBilling must be used within a BillingProvider");
	}
	return context;
}

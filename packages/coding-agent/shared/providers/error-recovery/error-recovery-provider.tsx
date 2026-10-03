import { createContext, type ReactNode, useContext, useMemo } from "react";

export type ErrorRecovery = Readonly<{
	quit: (exitCode: number) => void;
}>;

const ErrorRecoveryContext = createContext<ErrorRecovery | null>(null);

export function ErrorRecoveryProvider({
	children,
	quit,
}: {
	children: ReactNode;
	quit: (exitCode: number) => void;
}) {
	const value = useMemo<ErrorRecovery>(() => ({ quit }), [quit]);
	return (
		<ErrorRecoveryContext.Provider value={value}>
			{children}
		</ErrorRecoveryContext.Provider>
	);
}

export function useErrorRecovery(): ErrorRecovery {
	const context = useContext(ErrorRecoveryContext);
	if (context === null) {
		throw new Error(
			"useErrorRecovery must be used within an ErrorRecoveryProvider"
		);
	}
	return context;
}

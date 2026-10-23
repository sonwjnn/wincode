import { createContext, type ReactNode, useContext } from "react";
import type { TuiClipboard } from "./clipboard";

const ClipboardContext = createContext<TuiClipboard | null>(null);

export function useClipboard(): TuiClipboard {
	const clipboard = useContext(ClipboardContext);
	if (clipboard === null) {
		throw new Error("useClipboard must be used within a ClipboardProvider");
	}
	return clipboard;
}

export type ClipboardProviderProps = {
	clipboard: TuiClipboard;
	children: ReactNode;
};

export function ClipboardProvider({
	clipboard,
	children,
}: ClipboardProviderProps) {
	return (
		<ClipboardContext.Provider value={clipboard}>
			{children}
		</ClipboardContext.Provider>
	);
}

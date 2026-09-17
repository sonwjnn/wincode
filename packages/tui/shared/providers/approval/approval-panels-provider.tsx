import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import type {
	ApprovalOutcome,
	ToolApprovalActions,
	ToolApprovalRequest,
} from "./types";

/**
 * One approval as the session projects it into the panel surface. Pending
 * entries replace the composer with the approval controls, and a settled entry
 * renders its audit line; the session decides which requests reach this list.
 */
export type ApprovalPanelEntry = {
	actions: ToolApprovalActions;
	id: string;
	request: ToolApprovalRequest;
	resolution?: { feedback?: string; outcome: ApprovalOutcome };
};

/**
 * The read-only panel registry. The session publishes the approvals it owns
 * through `project`, and the panel surface reads that projection; it never
 * decides a settlement of its own, so closing the panel cannot leave a Tool
 * Gate evaluation waiting.
 */
export type ApprovalPanelsContextValue = {
	entries: readonly ApprovalPanelEntry[];
	project: (entries: readonly ApprovalPanelEntry[]) => void;
};

const ApprovalPanelsContext = createContext<ApprovalPanelsContextValue | null>(
	null
);

/**
 * Holds the approval projection for the session surface and the timeline audit
 * lines. Entries carry the `ToolApprovalActions` the session bound for them, so
 * the surface can allow once, grant, reject with feedback, or abort without a
 * modal or scroll-dependent interaction.
 */
export function ApprovalPanelsProvider({ children }: { children: ReactNode }) {
	const [entries, setEntries] = useState<readonly ApprovalPanelEntry[]>([]);

	const project = useCallback((next: readonly ApprovalPanelEntry[]): void => {
		setEntries((previous) => (previous === next ? previous : next));
	}, []);

	const value = useMemo(() => ({ entries, project }), [entries, project]);

	return (
		<ApprovalPanelsContext.Provider value={value}>
			{children}
		</ApprovalPanelsContext.Provider>
	);
}

export function useApprovalPanels(): ApprovalPanelsContextValue {
	const value = useContext(ApprovalPanelsContext);
	if (!value) {
		throw new Error(
			"useApprovalPanels must be used within an ApprovalPanelsProvider"
		);
	}
	return value;
}

import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	ApprovalOutcome,
	ToolApprovalActions,
	ToolApprovalRequest,
} from "./types";

/**
 * One live or recently settled approval panel. Tool-call entries (identified by
 * the pending tool call's `toolCallId`) stay in the registry after resolution
 * so the inline panel collapses to an audit line; conversation entries (explicit
 * Skill activation, no tool call yet) are removed on resolution because they
 * have no message part to anchor to.
 */
export type ApprovalPanelEntry = {
	actions: ToolApprovalActions;
	id: string;
	request: ToolApprovalRequest;
	resolution?: { feedback?: string; outcome: ApprovalOutcome };
	target: "conversation" | "tool-call";
};

export type ApprovalPanelsContextValue = {
	/**
	 * Registers a pending approval and returns its registry id: the request's
	 * `toolCallId` when present, otherwise a synthetic conversation id.
	 */
	add: (request: ToolApprovalRequest, actions: ToolApprovalActions) => string;
	entries: readonly ApprovalPanelEntry[];
	/** Settles a pending approval; conversation entries are then removed. */
	resolve: (id: string, outcome: ApprovalOutcome, feedback?: string) => void;
	/**
	 * Settles every unresolved entry. Mirrors the conversation approval queue's
	 * reject-all semantics: rejecting one panel rejects the pending siblings
	 * the queue settled, so they collapse to their audit lines instead of
	 * remaining interactive. The app renders one conversation at a time, so a
	 * registry-wide settle matches the queue's conversation scope.
	 */
	resolveAll: (outcome: ApprovalOutcome, feedback?: string) => void;
};

const ApprovalPanelsContext = createContext<ApprovalPanelsContextValue | null>(
	null
);

/**
 * Settles matching pending entries: conversation entries are removed on
 * resolution because they have no message part to anchor to, while tool-call
 * entries collapse to an audit line. Pure, so it lives outside the component.
 */
const withResolution = (
	prev: ApprovalPanelEntry[],
	id: string | undefined,
	outcome: ApprovalOutcome,
	feedback: string | undefined,
	settleAll: boolean
): ApprovalPanelEntry[] => {
	const matches = (entry: ApprovalPanelEntry) => settleAll || entry.id === id;
	return prev
		.filter(
			(entry) =>
				!(
					matches(entry) &&
					entry.target === "conversation" &&
					entry.resolution === undefined
				)
		)
		.map((entry) =>
			matches(entry) && entry.resolution === undefined
				? { ...entry, resolution: { feedback, outcome } }
				: entry
		);
};

/**
 * Session-scoped registry of pending and recently settled approvals. The chat
 * UI renders one inline panel per entry — anchored to the assistant message
 * whose tool call is pending, or above the composer for conversation-level
 * approvals — replacing the previous modal dialog. Entries carry the exact
 * `ToolApprovalActions` the queue wired for the request, so the panel can
 * allow once, grant, reject with feedback, or cancel through the shared
 * conversation approval queue.
 */
export function ApprovalPanelsProvider({ children }: { children: ReactNode }) {
	const [entries, setEntries] = useState<ApprovalPanelEntry[]>([]);
	const conversationCounter = useRef(0);

	const add = useCallback(
		(request: ToolApprovalRequest, actions: ToolApprovalActions): string => {
			const id =
				request.toolCallId ?? `conversation-${conversationCounter.current++}`;
			const entry: ApprovalPanelEntry = {
				actions,
				id,
				request,
				target: request.toolCallId === undefined ? "conversation" : "tool-call",
			};
			setEntries((prev) =>
				prev.some((candidate) => candidate.id === id)
					? prev.map((candidate) => (candidate.id === id ? entry : candidate))
					: [...prev, entry]
			);
			return id;
		},
		[]
	);

	const resolve = useCallback(
		(id: string, outcome: ApprovalOutcome, feedback?: string) => {
			setEntries((prev) => withResolution(prev, id, outcome, feedback, false));
		},
		[]
	);

	const resolveAll = useCallback(
		(outcome: ApprovalOutcome, feedback?: string) => {
			setEntries((prev) =>
				withResolution(prev, undefined, outcome, feedback, true)
			);
		},
		[]
	);

	const value = useMemo(
		() => ({ add, entries, resolve, resolveAll }),
		[add, entries, resolve, resolveAll]
	);

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

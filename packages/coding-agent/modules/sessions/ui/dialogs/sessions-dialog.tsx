import { RGBA } from "@opentui/core";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { getErrorMessage } from "@wincode/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatest } from "@/shared/hooks/use-latest";
import type { SessionId } from "@/shared/identifiers";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import { getSessionStore } from "../../storage/get-session-store";
import {
	projectSessionStorageError,
	requireSessionWriteReady,
} from "../../storage/session-jsonl-store";
import type { Session, SessionCatalogIssue } from "../../storage/session-store";
import { RenameSessionDialog } from "./rename-session-dialog";

const MAX_VISIBLE_ITEMS = 10;
const MIN_VISIBLE_ITEMS = 8;
const CONFIRM_DELETE_BG = RGBA.fromInts(60, 20, 20, 255);

type ListItem =
	| { kind: "header"; label: string; sectionKey: string }
	| { kind: "session"; session: Session }
	| { kind: "unavailable"; issue: SessionCatalogIssue };
const getSessionSectionKey = (item: ListItem): string => {
	if (item.kind === "header") {
		return item.sectionKey;
	}
	if (item.kind === "unavailable") {
		return "unavailable";
	}
	return item.session.pinned ? "pinned" : "recent";
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function buildListItems(
	sessions: readonly Session[],
	issues: readonly SessionCatalogIssue[],
	isSearching: boolean
): ListItem[] {
	const unavailableItems: ListItem[] = issues.map((issue) => ({
		kind: "unavailable",
		issue,
	}));
	if (isSearching) {
		return [
			...sessions.map((session) => ({
				kind: "session" as const,
				session,
			})),
			...unavailableItems,
		];
	}

	const pinned = sessions.filter((s) => s.pinned);
	const recent = sessions.filter((s) => !s.pinned);
	const items: ListItem[] = [];

	if (pinned.length > 0) {
		items.push({ kind: "header", label: "Pinned", sectionKey: "pinned" });
		for (const session of pinned) {
			items.push({ kind: "session", session });
		}
	}

	if (recent.length > 0) {
		items.push({ kind: "header", label: "Recent", sectionKey: "recent" });
		for (const session of recent) {
			items.push({ kind: "session", session });
		}
	}
	if (unavailableItems.length > 0) {
		items.push({
			kind: "header",
			label: "Unavailable",
			sectionKey: "unavailable",
		});
		items.push(...unavailableItems);
	}

	return items;
}

const getListItemKey = (item: ListItem): string => {
	if (item.kind === "header") {
		return `header:${item.label}`;
	}
	if (item.kind === "session") {
		return item.session.id;
	}
	return `unavailable:${item.issue.sessionId}`;
};

const getListItemSearchText = (item: ListItem): string => {
	if (item.kind === "session") {
		return item.session.title;
	}
	if (item.kind === "unavailable") {
		return `Unavailable Session ${item.issue.sessionId} ${item.issue.code} ${item.issue.message}`;
	}
	return "";
};

type SessionListItemProps = {
	session: Session;
	isSelected: boolean;
	isPendingDelete: boolean;
	isActiveRoute: boolean;
};

function SessionListItem({
	session,
	isSelected,
	isPendingDelete,
	isActiveRoute,
}: SessionListItemProps) {
	const { colors } = useTheme();
	const selectedTextColor = getContrastingTextColor(colors.selection);
	const primaryTextColor =
		isSelected && !isPendingDelete ? selectedTextColor : colors.text;
	const secondaryTextColor =
		isSelected && !isPendingDelete ? selectedTextColor : colors.textMuted;

	return (
		<SelectableDialogItem
			status={
				isActiveRoute ? (
					<text fg={primaryTextColor} selectable={false}>
						{"●"}
					</text>
				) : null
			}
		>
			<box flexDirection="row" flexGrow={1} marginRight={3}>
				<text fg={primaryTextColor} selectable={false}>
					{session.title}
				</text>
				<box flexGrow={1} />
				<text fg={secondaryTextColor} selectable={false}>
					{timeFormatter.format(
						new Date(session.lastMessageAt ?? session.createdAt)
					)}
				</text>
			</box>
		</SelectableDialogItem>
	);
}

export const SessionsDialogContent = () => {
	const [sessions, setSessions] = useState<Session[]>([]);
	const [catalogIssues, setCatalogIssues] = useState<SessionCatalogIssue[]>([]);
	const [loading, setLoading] = useState(true);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const pendingDeleteIdRef = useLatest(pendingDeleteId);
	const { close, open: openDialog } = useDialog();
	const navigate = useNavigate();
	const { show } = useToast();
	const { colors } = useTheme();
	const routerState = useRouterState();

	const currentSessionId = useMemo(() => {
		const path = routerState.location.pathname;
		if (path.startsWith("/sessions/")) {
			return path.split("/")[2] ?? null;
		}
		return null;
	}, [routerState.location.pathname]);
	const selectedSessionRef = useLatest(
		sessions.find((session) => session.id === currentSessionId) ??
			sessions.find((session) => session.pinned) ??
			sessions[0] ??
			null
	);

	const fetchSessions = useCallback(
		async (ignoreRef?: { current: boolean }) => {
			try {
				const catalog = await getSessionStore().listSessionCatalog();
				if (ignoreRef?.current) {
					return;
				}
				setSessions(catalog.sessions);
				setCatalogIssues(catalog.issues);
				setLoading(false);
			} catch (error) {
				if (ignoreRef?.current) {
					return;
				}
				show({
					variant: "error",
					message: getErrorMessage(error, "Failed to fetch sessions"),
				});
				close();
			}
		},
		[close, show]
	);

	useEffect(() => {
		const ignoreRef = { current: false };
		fetchSessions(ignoreRef);
		return () => {
			ignoreRef.current = true;
		};
	}, [fetchSessions]);

	const navigateToSession = useCallback(
		(session: Session) => {
			close();
			navigate({ params: { id: session.id }, to: "/sessions/$id" }).catch(
				() => undefined
			);
		},
		[close, navigate]
	);

	const togglePin = useCallback(
		async (session: Session) => {
			const original = sessions.slice();
			const updated = original
				.map((s) => (s.id === session.id ? { ...s, pinned: !s.pinned } : s))
				.sort((a, b) => {
					if (a.pinned !== b.pinned) {
						return b.pinned ? 1 : -1;
					}
					return (
						new Date(b.lastMessageAt ?? b.createdAt).getTime() -
						new Date(a.lastMessageAt ?? a.createdAt).getTime()
					);
				});

			setSessions(updated);
			try {
				requireSessionWriteReady(
					await getSessionStore().updateSession(session.id, {
						pinned: !session.pinned,
					})
				);
			} catch (error) {
				const writeOutcome =
					error instanceof Error
						? projectSessionStorageError(error)?.writeOutcome
						: undefined;
				if (writeOutcome?.kind !== "committed") {
					setSessions(original);
				}
				show({
					variant: "error",
					message: getErrorMessage(error, "Failed to update session"),
				});
			}
		},
		[sessions, show]
	);

	const confirmDelete = useCallback(
		async (session: Session) => {
			const original = sessions.slice();
			setSessions((prev) => prev.filter((s) => s.id !== session.id));
			setPendingDeleteId(null);
			try {
				requireSessionWriteReady(
					await getSessionStore().deleteSession(session.id)
				);
			} catch (error) {
				const writeOutcome =
					error instanceof Error
						? projectSessionStorageError(error)?.writeOutcome
						: undefined;
				if (writeOutcome?.kind !== "committed") {
					setSessions(original);
				}
				show({
					variant: "error",
					message: getErrorMessage(error, "Failed to delete session"),
				});
			}
		},
		[sessions, show]
	);

	const handleRenameSuccess = useCallback(
		(sessionId: SessionId, newTitle: string) => {
			setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
			);
		},
		[]
	);

	const openRename = useCallback(
		(session: Session) => {
			openDialog({
				children: (
					<RenameSessionDialog
						onSuccess={(newTitle) => handleRenameSuccess(session.id, newTitle)}
						session={session}
					/>
				),
				title: "Rename Session",
			});
		},
		[openDialog, handleRenameSuccess]
	);

	const handleActionKeysRef = useRef(
		(_key: { ctrl: boolean; name: string }) => false as boolean
	);

	handleActionKeysRef.current = (key) => {
		const session = selectedSessionRef.current;
		const pending = pendingDeleteIdRef.current;
		if (!session) {
			return false;
		}

		if (key.ctrl && key.name === "f") {
			togglePin(session);
			return true;
		}

		if (key.ctrl && key.name === "d") {
			if (pending === session.id) {
				confirmDelete(session);
			} else {
				setPendingDeleteId(session.id);
			}
			return true;
		}

		if (key.ctrl && key.name === "r") {
			openRename(session);
			return true;
		}

		return false;
	};

	const handleHighlight = useCallback((item: ListItem) => {
		if (item.kind === "session") {
			selectedSessionRef.current = item.session;
			setPendingDeleteId(null);
		}
	}, []);

	const isConfirmDelete =
		pendingDeleteId && pendingDeleteId === selectedSessionRef.current?.id;
	let emptyText = "No matching sessions";
	if (loading) {
		emptyText = "Loading sessions...";
	} else if (catalogIssues.length > 0) {
		emptyText = "No usable sessions; see Unavailable below";
	}
	const renderItem = (
		item: ListItem,
		isSelected: boolean,
		isActive: boolean
	) => {
		if (item.kind === "header") {
			return (
				<SelectableDialogItem>
					<text fg={colors.primary}>{item.label}</text>
				</SelectableDialogItem>
			);
		}
		if (item.kind === "unavailable") {
			return (
				<SelectableDialogItem>
					<text fg={colors.error} selectable={false}>
						{`Session ${item.issue.sessionId} unavailable (${item.issue.code}): ${item.issue.message}`}
					</text>
				</SelectableDialogItem>
			);
		}
		return (
			<SessionListItem
				isActiveRoute={isActive}
				isPendingDelete={pendingDeleteId === item.session.id}
				isSelected={isSelected}
				session={item.session}
			/>
		);
	};

	return (
		<SearchListDialogWrapper<ListItem>
			emptyText={emptyText}
			footerHints={
				<>
					{!loading && isConfirmDelete ? (
						<>
							<DialogFooterHint
								label="confirm delete"
								shortcut="ctrl+d again"
								shortcutColor={colors.error}
							/>
							<DialogFooterHint label="cancel" shortcut="esc" />
						</>
					) : null}
					{loading || isConfirmDelete ? null : (
						<>
							<DialogFooterHint label="pin/unpin" shortcut="ctrl+f" />
							<DialogFooterHint label="delete" shortcut="ctrl+d" />
							<DialogFooterHint label="rename" shortcut="ctrl+r" />
						</>
					)}
				</>
			}
			getItemBackgroundColor={(item) => {
				if (item.kind === "session" && pendingDeleteId === item.session.id) {
					return CONFIRM_DELETE_BG;
				}
				return;
			}}
			getItemSectionKey={getSessionSectionKey}
			getKey={getListItemKey}
			getSearchText={getListItemSearchText}
			isItemActive={(item) =>
				item.kind === "session" && item.session.id === currentSessionId
			}
			isItemSelectable={(item) => item.kind === "session"}
			items={buildListItems(sessions, catalogIssues, false)}
			maxVisibleItems={MAX_VISIBLE_ITEMS}
			minVisibleItems={MIN_VISIBLE_ITEMS}
			onHighlight={handleHighlight}
			onKey={(key) => {
				if (key.name === "escape") {
					if (pendingDeleteIdRef.current) {
						setPendingDeleteId(null);
					} else {
						close();
					}
					return true;
				}
				return handleActionKeysRef.current(key);
			}}
			onSelect={(item) =>
				item.kind === "session" && navigateToSession(item.session)
			}
			placeholder="Search sessions"
			renderItem={renderItem}
		/>
	);
};

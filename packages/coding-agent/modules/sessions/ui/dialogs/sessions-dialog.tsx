import { RGBA } from "@opentui/core";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { getErrorMessage } from "@wincode/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatest } from "@/shared/hooks/use-latest";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import { getInteractiveSessionHostManager } from "../../host/session-host-manager";
import { getSessionStore } from "../../storage/get-session-store";
import {
	projectSessionStorageError,
	requireSessionWriteReady,
} from "../../storage/session-jsonl-store";
import type { Session } from "../../storage/session-store";
import { ExportSessionDialog } from "./export-session-dialog";
import { ImportSessionDialog } from "./import-session-dialog";
import { RenameSessionDialog } from "./rename-session-dialog";

const MAX_VISIBLE_ITEMS = 10;
const MIN_VISIBLE_ITEMS = 8;
const CONFIRM_DELETE_BG = RGBA.fromInts(60, 20, 20, 255);

const sessionCatalogErrorMessage = (error: unknown): string => {
	const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
	return code === "cursor_expired"
		? "Session list changed. Refresh sessions to start a new snapshot."
		: getErrorMessage(error, "Failed to fetch sessions");
};

type ListItem =
	| { kind: "header"; label: string; sectionKey: string }
	| { kind: "load-more"; loading: boolean }
	| { kind: "notice"; message: string }
	| { kind: "session"; session: Session };
const getSessionSectionKey = (item: ListItem): string => {
	if (item.kind === "header") {
		return item.sectionKey;
	}
	if (item.kind === "session") {
		return item.session.pinned ? "pinned" : "recent";
	}
	return "pagination";
};

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function buildListItems(
	sessions: readonly Session[],
	isSearching: boolean,
	hasMore: boolean,
	loadingMore: boolean,
	notice?: string
): ListItem[] {
	if (isSearching) {
		const items: ListItem[] = sessions.map((session) => ({
			kind: "session",
			session,
		}));
		if (notice !== undefined) {
			items.push({ kind: "notice", message: notice });
		}
		if (hasMore) {
			items.push({ kind: "load-more", loading: loadingMore });
		}
		return items;
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
	if (notice !== undefined) {
		items.push({ kind: "notice", message: notice });
	}
	if (hasMore) {
		items.push({ kind: "load-more", loading: loadingMore });
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
	if (item.kind === "load-more") {
		return "catalog:load-more";
	}
	return "catalog:notice";
};

const getListItemSearchText = (item: ListItem): string => {
	if (item.kind === "session") {
		return `${item.session.title} ${item.session.id}`;
	}
	if (item.kind === "load-more") {
		return "Load more sessions";
	}
	if (item.kind === "notice") {
		return item.message;
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
	const [nextCursor, setNextCursor] = useState<string | undefined>();
	const [readPoint, setReadPoint] = useState<string | undefined>();
	const [catalogError, setCatalogError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const pageRequestIdRef = useRef(0);
	const pendingDeleteIdRef = useLatest(pendingDeleteId);
	const { close, closeAll, open: openDialog } = useDialog();
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
			const requestId = ++pageRequestIdRef.current;
			setLoading(true);
			setLoadingMore(false);
			setNextCursor(undefined);
			setReadPoint(undefined);
			setCatalogError(undefined);
			try {
				const page = await getSessionStore().listSessionsPage();
				if (ignoreRef?.current || requestId !== pageRequestIdRef.current) {
					return;
				}
				setSessions(page.sessions);
				setNextCursor(page.nextCursor);
				setReadPoint(page.readPoint);
			} catch (error) {
				if (ignoreRef?.current || requestId !== pageRequestIdRef.current) {
					return;
				}
				setCatalogError(sessionCatalogErrorMessage(error));
			} finally {
				if (!ignoreRef?.current && requestId === pageRequestIdRef.current) {
					setLoading(false);
				}
			}
		},
		[]
	);

	useEffect(() => {
		const ignoreRef = { current: false };
		fetchSessions(ignoreRef);
		return () => {
			ignoreRef.current = true;
		};
	}, [fetchSessions]);

	const loadMoreSessions = useCallback(async () => {
		const cursor = nextCursor;
		const requestId = pageRequestIdRef.current;
		if (cursor === undefined || loadingMore) {
			return;
		}
		setLoadingMore(true);
		setCatalogError(undefined);
		try {
			const page = await getSessionStore().listSessionsPage({ cursor });
			if (requestId !== pageRequestIdRef.current) {
				return;
			}
			if (page.readPoint !== readPoint) {
				setNextCursor(undefined);
				setCatalogError(
					"Session page did not match the captured snapshot. Refresh sessions to continue."
				);
				return;
			}
			setSessions((current) => [...current, ...page.sessions]);
			setNextCursor(page.nextCursor);
		} catch (error) {
			if (requestId !== pageRequestIdRef.current) {
				return;
			}
			if (
				error instanceof Error &&
				Reflect.get(error, "code") === "cursor_expired"
			) {
				setNextCursor(undefined);
			}
			setCatalogError(sessionCatalogErrorMessage(error));
		} finally {
			if (requestId === pageRequestIdRef.current) {
				setLoadingMore(false);
			}
		}
	}, [loadingMore, nextCursor, readPoint]);

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
			try {
				requireSessionWriteReady(
					await getSessionStore().updateSession(session.id, {
						pinned: !session.pinned,
					})
				);
				await fetchSessions();
			} catch (error) {
				show({
					variant: "error",
					message: getErrorMessage(error, "Failed to update session"),
				});
			}
		},
		[fetchSessions, show]
	);

	const confirmDelete = useCallback(
		async (session: Session) => {
			const original = sessions.slice();
			setSessions((prev) => prev.filter((s) => s.id !== session.id));
			setPendingDeleteId(null);
			try {
				const deletion =
					await getInteractiveSessionHostManager().withIdleForSessionLifecycle(
						session.id,
						() => getSessionStore().deleteSession(session.id)
					);
				if (deletion.kind === "cleanup-pending") {
					setNextCursor(undefined);
					setCatalogError(
						"Session deletion is committed, but cleanup is pending. Refresh sessions to retry cleanup."
					);
					show({ variant: "error", message: deletion.message });
					return;
				}
				requireSessionWriteReady(deletion);
				await fetchSessions();
			} catch (error) {
				const writeOutcome =
					error instanceof Error
						? projectSessionStorageError(error)?.writeOutcome
						: undefined;
				if (writeOutcome?.kind === "committed") {
					setNextCursor(undefined);
					setCatalogError(
						"Session deletion is committed, but cleanup is pending. Refresh sessions to retry cleanup."
					);
				} else {
					setSessions(original);
				}
				show({
					variant: "error",
					message: getErrorMessage(error, "Failed to delete session"),
				});
			}
		},
		[fetchSessions, sessions, show]
	);

	const handleRenameSuccess = useCallback(() => {
		void fetchSessions();
	}, [fetchSessions]);

	const openRename = useCallback(
		(session: Session) => {
			openDialog({
				children: (
					<RenameSessionDialog
						onSuccess={() => handleRenameSuccess()}
						session={session}
					/>
				),
				title: "Rename Session",
			});
		},
		[openDialog, handleRenameSuccess]
	);

	const openExport = useCallback(
		(session: Session) => {
			openDialog({
				children: <ExportSessionDialog session={session} />,
				title: "Export Session Bundle",
			});
		},
		[openDialog]
	);

	const openImport = useCallback(() => {
		openDialog({
			children: (
				<ImportSessionDialog
					onImported={async (result) => {
						await fetchSessions();
						closeAll();
						void navigate({
							params: { id: result.sessionId },
							to: "/sessions/$id",
						}).catch(() => undefined);
					}}
				/>
			),
			title: "Import Session Bundle",
		});
	}, [closeAll, fetchSessions, navigate, openDialog]);

	const handleSelectedSessionAction = (
		key: { ctrl: boolean; name: string; shift?: boolean },
		session: Session,
		pendingDelete: string | null
	): boolean => {
		if (key.ctrl && key.name === "f") {
			togglePin(session);
			return true;
		}
		if (key.ctrl && key.name === "d") {
			if (pendingDelete === session.id) {
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
		if (key.ctrl && key.name === "e") {
			openExport(session);
			return true;
		}
		return false;
	};

	const handleActionKeysRef = useRef(
		(_key: { ctrl: boolean; name: string; shift?: boolean }) => false as boolean
	);

	handleActionKeysRef.current = (key) => {
		if (key.ctrl && key.shift && key.name.toLowerCase() === "r") {
			void fetchSessions();
			return true;
		}
		if (key.ctrl && key.name === "down") {
			void loadMoreSessions();
			return true;
		}
		if (key.ctrl && key.name === "o") {
			openImport();
			return true;
		}
		const session = selectedSessionRef.current;
		return session === null
			? false
			: handleSelectedSessionAction(key, session, pendingDeleteIdRef.current);
	};

	const handleHighlight = useCallback((item: ListItem) => {
		if (item.kind === "session") {
			selectedSessionRef.current = item.session;
			setPendingDeleteId((pending) =>
				pending === item.session.id ? pending : null
			);
		} else {
			selectedSessionRef.current = null;
			setPendingDeleteId(null);
		}
	}, []);

	const isConfirmDelete =
		pendingDeleteId && pendingDeleteId === selectedSessionRef.current?.id;
	const emptyText = loading
		? "Loading sessions..."
		: (catalogError ?? "No matching sessions");
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
		if (item.kind === "notice") {
			return (
				<SelectableDialogItem>
					<text fg={colors.error} selectable={false}>
						{item.message}
					</text>
				</SelectableDialogItem>
			);
		}
		if (item.kind === "load-more") {
			return (
				<SelectableDialogItem>
					<text fg={colors.primary} selectable={false}>
						{item.loading ? "Loading more sessions..." : "Load more sessions"}
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
							<DialogFooterHint label="export bundle" shortcut="ctrl+e" />
							<DialogFooterHint label="import bundle" shortcut="ctrl+o" />
							{nextCursor === undefined ? null : (
								<DialogFooterHint label="load more" shortcut="ctrl+↓" />
							)}
						</>
					)}
					{isConfirmDelete ? null : (
						<DialogFooterHint label="refresh" shortcut="ctrl+shift+r" />
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
			isItemSelectable={(item) =>
				(item.kind === "session" || item.kind === "load-more") &&
				!loading &&
				!loadingMore
			}
			items={buildListItems(
				sessions,
				false,
				nextCursor !== undefined,
				loadingMore,
				catalogError
			)}
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
			onSelect={(item) => {
				if (item.kind === "session") {
					navigateToSession(item.session);
				} else if (item.kind === "load-more") {
					void loadMoreSessions();
				}
			}}
			placeholder="Search sessions"
			renderItem={renderItem}
		/>
	);
};

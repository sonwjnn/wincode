import { RGBA, TextAttributes } from "@opentui/core";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLatest } from "@/shared/hooks/use-latest";
import { useDialog } from "@/shared/providers/dialog/dialog-provider";
import { getContrastingTextColor } from "@/shared/providers/theme/color-contrast";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";
import { SelectableDialogItem } from "@/shared/ui/selectable-dialog-item";
import type { ConversationSession } from "../../storage/conversation-store";
import { getConversationStore } from "../../storage/get-conversation-store";
import { RenameSessionDialog } from "./rename-session-dialog";

const MAX_VISIBLE_ITEMS = 10;
const MIN_VISIBLE_ITEMS = 8;
const CONFIRM_DELETE_BG = RGBA.fromInts(60, 20, 20, 255);

type ListItem =
	| { kind: "header"; label: string }
	| { kind: "session"; session: ConversationSession };

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function buildListItems(
	sessions: readonly ConversationSession[],
	isSearching: boolean
): ListItem[] {
	if (isSearching) {
		return sessions.map((session) => ({
			kind: "session" as const,
			session,
		}));
	}

	const pinned = sessions.filter((s) => s.pinned);
	const recent = sessions.filter((s) => !s.pinned);
	const items: ListItem[] = [];

	if (pinned.length > 0) {
		items.push({ kind: "header", label: "Pinned" });
		for (const session of pinned) {
			items.push({ kind: "session", session });
		}
	}

	if (recent.length > 0) {
		items.push({ kind: "header", label: "Recent" });
		for (const session of recent) {
			items.push({ kind: "session", session });
		}
	}

	return items;
}

type SessionListItemProps = {
	session: ConversationSession;
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
				<text
					attributes={TextAttributes.DIM}
					fg={secondaryTextColor}
					selectable={false}
				>
					{timeFormatter.format(
						new Date(session.lastMessageAt ?? session.createdAt)
					)}
				</text>
			</box>
		</SelectableDialogItem>
	);
}

export const SessionsDialogContent = () => {
	const [sessions, setSessions] = useState<ConversationSession[]>([]);
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

	const filterFn = useCallback(
		(session: ConversationSession, query: string) =>
			session.title.toLowerCase().includes(query.toLowerCase()),
		[]
	);

	const fetchSessions = useCallback(
		async (ignoreRef?: { current: boolean }) => {
			try {
				const data = await getConversationStore().listSessions();
				if (ignoreRef?.current) {
					return;
				}
				setSessions(data);
				setLoading(false);
			} catch (error) {
				if (ignoreRef?.current) {
					return;
				}
				show({
					variant: "error",
					message:
						error instanceof Error ? error.message : "Failed to fetch sessions",
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
		(session: ConversationSession) => {
			close();
			navigate({ params: { id: session.id }, to: "/sessions/$id" }).catch(
				() => undefined
			);
		},
		[close, navigate]
	);

	const togglePin = useCallback(
		async (session: ConversationSession) => {
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
				await getConversationStore().updateSession(session.id, {
					pinned: !session.pinned,
				});
			} catch (error) {
				setSessions(original);
				show({
					variant: "error",
					message:
						error instanceof Error ? error.message : "Failed to update session",
				});
			}
		},
		[sessions, show]
	);

	const confirmDelete = useCallback(
		async (session: ConversationSession) => {
			const original = sessions.slice();
			setSessions((prev) => prev.filter((s) => s.id !== session.id));
			setPendingDeleteId(null);
			try {
				await getConversationStore().deleteSession(session.id);
			} catch (error) {
				setSessions(original);
				show({
					variant: "error",
					message:
						error instanceof Error ? error.message : "Failed to delete session",
				});
			}
		},
		[sessions, show]
	);

	const handleRenameSuccess = useCallback(
		(sessionId: string, newTitle: string) => {
			setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
			);
		},
		[]
	);

	const openRename = useCallback(
		(session: ConversationSession) => {
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

	return (
		<SearchListDialogWrapper<ListItem>
			emptyText={loading ? "Loading sessions..." : "No matching sessions"}
			filterFn={(item, query) =>
				item.kind === "header"
					? query.length === 0
					: filterFn(item.session, query)
			}
			footer={
				loading ? null : (
					<box flexDirection="row" gap={2} height={1} marginX={4}>
						{isConfirmDelete ? (
							<>
								<text fg={colors.error}>delete</text>
								<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
									ctrl+d again to confirm
								</text>
								<text fg={colors.text}>esc</text>
								<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
									cancel
								</text>
							</>
						) : (
							<>
								<text fg={colors.text}>pin/unpin</text>
								<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
									ctrl+f
								</text>
								<text fg={colors.text}>delete</text>
								<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
									ctrl+d
								</text>
								<text fg={colors.text}>rename</text>
								<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
									ctrl+r
								</text>
							</>
						)}
					</box>
				)
			}
			getItemBackgroundColor={(item) => {
				if (item.kind === "session" && pendingDeleteId === item.session.id) {
					return CONFIRM_DELETE_BG;
				}
				return;
			}}
			getKey={(item) =>
				item.kind === "header" ? `header:${item.label}` : item.session.id
			}
			isItemActive={(item) =>
				item.kind === "session" && item.session.id === currentSessionId
			}
			isItemSelectable={(item) => item.kind === "session"}
			items={buildListItems(sessions, false)}
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
			renderItem={(item, isSelected, isActive) =>
				item.kind === "header" ? (
					<text
						attributes={TextAttributes.BOLD}
						fg={colors.text}
						marginLeft={3}
					>
						{item.label}
					</text>
				) : (
					<SessionListItem
						isActiveRoute={isActive}
						isPendingDelete={pendingDeleteId === item.session.id}
						isSelected={isSelected}
						session={item.session}
					/>
				)
			}
		/>
	);
};

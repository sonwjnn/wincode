import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchableList } from "@/shared/hooks/use-searchable-list";
import {
	useDialog,
	useDialogLayer,
} from "@/shared/providers/dialog/dialog-provider";
import { useKeyboardLayer } from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { useToast } from "@/shared/providers/toast/toast-provider";
import type { ConversationSession } from "../../storage/conversation-store";
import { getConversationStore } from "../../storage/get-conversation-store";
import { RenameSessionDialog } from "./rename-session-dialog";

const MAX_VISIBLE_ITEMS = 10;
const MIN_VISIBLE_ITEMS = 8;
const CONFIRM_DELETE_BG = RGBA.fromInts(60, 20, 20, 255);

type Session = ConversationSession;

type ListItem =
	| { kind: "header"; label: string }
	| { kind: "session"; session: Session };

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

function buildListItems(
	sessions: readonly Session[],
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

function getItemBackgroundColor(
	isPendingDelete: boolean,
	isSelected: boolean,
	selectionColor: string
): string | RGBA | undefined {
	if (isPendingDelete) {
		return CONFIRM_DELETE_BG;
	}
	if (isSelected) {
		return selectionColor;
	}
	return;
}

function getItemForeground(
	isPendingDelete: boolean,
	isSelected: boolean
): string {
	if (isPendingDelete) {
		return "white";
	}
	if (isSelected) {
		return "black";
	}
	return "white";
}

function getTimeForegroundColor(
	isPendingDelete: boolean,
	isSelected: boolean
): string | undefined {
	if (isPendingDelete) {
		return "white";
	}
	if (isSelected) {
		return "black";
	}
	return;
}

type SessionListItemProps = {
	session: Session;
	isSelected: boolean;
	isPendingDelete: boolean;
	isActiveRoute: boolean;
	isLastInGroup: boolean;
	selectionColor: string;
	onMouseDown: () => void;
	onMouseMove: () => void;
};

function SessionListItem({
	session,
	isSelected,
	isPendingDelete,
	isActiveRoute,
	isLastInGroup,
	selectionColor,
	onMouseDown,
	onMouseMove,
}: SessionListItemProps) {
	const bg = getItemBackgroundColor(
		isPendingDelete,
		isSelected,
		selectionColor
	);
	const fg = getItemForeground(isPendingDelete, isSelected);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
		<box
			backgroundColor={bg}
			flexDirection="row"
			height={1}
			key={session.id}
			marginBottom={isLastInGroup ? 1 : 0}
			marginX={1}
			onMouseDown={onMouseDown}
			onMouseMove={onMouseMove}
			overflow="hidden"
		>
			{isActiveRoute && (
				<text fg={fg} marginLeft={1} selectable={false} width={2}>
					{"\u25cf"}
				</text>
			)}
			<box
				flexDirection="row"
				flexGrow={1}
				marginLeft={isActiveRoute ? 0 : 3}
				marginRight={3}
			>
				<text fg={fg} selectable={false}>
					{session.title}
				</text>
				<box flexGrow={1} />
				<text
					attributes={TextAttributes.DIM}
					fg={getTimeForegroundColor(isPendingDelete, isSelected)}
					selectable={false}
				>
					{timeFormatter.format(
						new Date(session.lastMessageAt ?? session.createdAt)
					)}
				</text>
			</box>
		</box>
	);
}

export const SessionsDialogContent = () => {
	const [sessions, setSessions] = useState<Session[]>([]);
	const [loading, setLoading] = useState(true);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const pendingDeleteIdRef = useRef<string | null>(null);
	const selectedSessionRef = useRef<Session | null>(null);
	const { close, open: openDialog } = useDialog();
	const navigate = useNavigate();
	const { show } = useToast();
	const { colors } = useTheme();
	const { isTopLayer } = useKeyboardLayer();
	const layerId = useDialogLayer();
	const routerState = useRouterState();

	const currentSessionId = useMemo(() => {
		const path = routerState.location.pathname;
		if (path.startsWith("/sessions/")) {
			return path.split("/")[2] ?? null;
		}
		return null;
	}, [routerState.location.pathname]);

	const filterFn = useCallback(
		(session: Session, query: string) =>
			session.title.toLowerCase().includes(query.toLowerCase()),
		[]
	);

	const {
		filtered: filteredSessions,
		searchValue,
		selectedIndex,
		setSelectedIndex,
		inputRef,
		scrollRef,
		handleContentChange,
		moveUp,
		moveDown,
		handleEnter,
	} = useSearchableList(sessions, filterFn);

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

	useEffect(() => {
		if (searchValue !== undefined) {
			setPendingDeleteId(null);
		}
	}, [searchValue]);

	const listItems = useMemo(
		() => buildListItems(filteredSessions, searchValue.trim().length > 0),
		[filteredSessions, searchValue]
	);

	const visibleHeight = useMemo(
		() =>
			Math.max(
				MIN_VISIBLE_ITEMS,
				Math.min(listItems.length, MAX_VISIBLE_ITEMS)
			),
		[listItems.length]
	);

	const selectedSession = filteredSessions[selectedIndex] ?? null;

	useEffect(() => {
		selectedSessionRef.current = selectedSession;
	}, [selectedSession]);

	useEffect(() => {
		pendingDeleteIdRef.current = pendingDeleteId;
	}, [pendingDeleteId]);

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
		async (session: Session) => {
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

	const handleUp = useCallback(() => {
		moveUp(() => setPendingDeleteId(null));
	}, [moveUp]);

	const handleDown = useCallback(() => {
		moveDown(() => setPendingDeleteId(null));
	}, [moveDown]);

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

	useKeyboard((key) => {
		if (!isTopLayer(layerId)) {
			return;
		}

		if (key.name === "escape") {
			if (pendingDeleteIdRef.current) {
				setPendingDeleteId(null);
			} else {
				close();
			}
			return;
		}

		if (key.name === "up") {
			key.preventDefault();
			handleUp();
			return;
		}

		if (key.name === "down") {
			key.preventDefault();
			handleDown();
			return;
		}

		if (key.name === "return" || key.name === "enter") {
			key.preventDefault();
			setPendingDeleteId(null);
			const session = selectedSessionRef.current;
			if (session) {
				handleEnter(() => navigateToSession(session));
			}
			return;
		}

		if (handleActionKeysRef.current(key)) {
			key.preventDefault();
		}
	});

	if (loading) {
		return (
			<box flexDirection="column">
				<text attributes={TextAttributes.DIM} marginLeft={4}>
					Loading sessions...
				</text>
			</box>
		);
	}

	const isConfirmDelete =
		pendingDeleteId &&
		selectedSession &&
		pendingDeleteId === selectedSession.id;

	return (
		<box flexDirection="column" gap={1}>
			<input
				focused
				marginX={4}
				onContentChange={handleContentChange}
				placeholder="Search sessions"
				ref={inputRef}
			/>
			{listItems.length === 0 ? (
				<text
					attributes={TextAttributes.DIM}
					height={visibleHeight}
					marginX={4}
				>
					No matching sessions
				</text>
			) : (
				<scrollbox height={visibleHeight} ref={scrollRef}>
					{listItems.map((item, index) => {
						if (item.kind === "header") {
							return (
								<box height={1} key={item.label} marginX={4}>
									<text attributes={TextAttributes.BOLD}>{item.label}</text>
								</box>
							);
						}

						const session = item.session;
						const isSelected = session === selectedSession;
						const isPendingDelete = pendingDeleteId === session.id;
						const isActiveRoute = currentSessionId === session.id;
						const isLastInGroup =
							index === listItems.length - 1 ||
							listItems[index + 1]?.kind === "header";

						return (
							<SessionListItem
								isActiveRoute={isActiveRoute}
								isLastInGroup={isLastInGroup}
								isPendingDelete={isPendingDelete}
								isSelected={isSelected}
								key={session.id}
								onMouseDown={() => {
									setPendingDeleteId(null);
									navigateToSession(session);
								}}
								onMouseMove={() => {
									const idx = filteredSessions.findIndex(
										(s) => s.id === session.id
									);
									if (idx !== -1) {
										setSelectedIndex(idx);
										if (pendingDeleteId && pendingDeleteId !== session.id) {
											setPendingDeleteId(null);
										}
									}
								}}
								selectionColor={colors.selection}
								session={session}
							/>
						);
					})}
				</scrollbox>
			)}
			<box flexDirection="row" gap={2} height={1} marginX={4}>
				{isConfirmDelete ? (
					<>
						<text fg="#ff6666">delete</text>
						<text attributes={TextAttributes.DIM}>ctrl+d again to confirm</text>
						<text>esc</text>
						<text attributes={TextAttributes.DIM}>cancel</text>
					</>
				) : (
					<>
						<text>pin/unpin</text>
						<text attributes={TextAttributes.DIM}>ctrl+f</text>
						<text>delete</text>
						<text attributes={TextAttributes.DIM}>ctrl+d</text>
						<text>rename</text>
						<text attributes={TextAttributes.DIM}>ctrl+r</text>
					</>
				)}
			</box>
		</box>
	);
};

import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { SessionRecordId } from "@wincode/agent-core";
import { getErrorMessage } from "@wincode/utils";
import { randomUUIDv7 } from "bun";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSdk } from "@/modules/sessions/sdk-contract";
import type {
	SessionHistoryTreeEntry,
	SessionHistoryTreePage,
} from "@/modules/sessions/session-pagination-types";
import { stripControlCharacters } from "@/shared/display-sanitize";
import type { SessionId } from "@/shared/identifiers";
import {
	useDialog,
	useDialogEscape,
} from "@/shared/providers/dialog/dialog-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { DialogFooterHint } from "@/shared/ui/dialog-footer-hint";
import { SearchListDialogWrapper } from "@/shared/ui/search-list-dialog-wrapper";

const DIALOG_CHROME_ROWS = 14;
const HISTORY_PAGE_SIZE = 40;
const MAX_TREE_INDENT = 12;
const MAX_PREVIEW_LENGTH = 4000;

type SessionHistoryReader = Pick<
	SessionSdk,
	"navigateSessionHistory" | "readSessionHistoryTreePage"
>;
type HistoryTreeKey = Readonly<{ ctrl: boolean; name: string }>;

type SessionHistoryTreeDialogContentProps = {
	readonly isRewindDisabled?: boolean;
	readonly onForkCheckpoint?: (recordId: SessionRecordId) => Promise<SessionId>;
	readonly onRewindCheckpoint?: (recordId: SessionRecordId) => Promise<void>;
	readonly sessionId: SessionId;
	readonly sessionSdk: SessionHistoryReader;
};

const normalizeHistoryLabel = (value: string): string =>
	stripControlCharacters(value).replace(/\s+/gu, " ").trim();

const getRecordText = (
	entry: Extract<SessionHistoryTreeEntry, { kind: "record" }>
): string =>
	normalizeHistoryLabel(
		entry.record.messages
			.flatMap((message) =>
				message.parts.flatMap((part) =>
					part.type === "text" ? [part.text] : []
				)
			)
			.join(" ")
	);

const getPluginStateEntryTitle = (
	entry: Extract<SessionHistoryTreeEntry, { kind: "plugin-state" }>
): string => {
	const pluginId = normalizeHistoryLabel(entry.pluginId);
	const key = normalizeHistoryLabel(entry.key);
	return `Plugin State · ${pluginId} / ${key}`;
};

const getPluginHistoryEntryTitle = (
	entry: Extract<SessionHistoryTreeEntry, { kind: "plugin-entry" }>
): string => {
	const pluginId = normalizeHistoryLabel(entry.pluginId);
	const type = normalizeHistoryLabel(entry.type);
	return `Plugin Entry · ${pluginId} / ${type}`;
};

const getEntrySummary = (entry: SessionHistoryTreeEntry): string => {
	switch (entry.kind) {
		case "plugin-state":
			return `${getPluginStateEntryTitle(entry)} · ${entry.operation} · v${entry.schemaVersion}`;
		case "plugin-entry":
			return getPluginHistoryEntryTitle(entry);
		case "record": {
			const role =
				entry.record.messages.at(-1)?.role ?? entry.record.outcome.kind;
			const text = getRecordText(entry);
			return `Record · ${role}${text.length === 0 ? "" : ` · ${text.slice(0, 180)}`}`;
		}
		case "context-edit":
			return `Context Edit · ${entry.operation} · message ${entry.targetId}`;
		case "compaction":
			return `Compaction · ${entry.trigger} · ${entry.compactionId}`;
		case "submission-status":
			return `Submission · ${entry.status} · message ${entry.messageId}`;
		default:
			throw new Error("Unsupported Session history entry kind.");
	}
};

const getEntryDepths = (
	entries: readonly SessionHistoryTreeEntry[]
): ReadonlyMap<string, number> => {
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const depths = new Map<string, number>();
	for (const entry of entries) {
		let parentId = entry.parentEntryId;
		let depth = 0;
		while (parentId !== null && depth < MAX_TREE_INDENT) {
			const parent = entriesById.get(parentId);
			if (parent === undefined) {
				break;
			}
			depth += 1;
			parentId = parent.parentEntryId;
		}
		depths.set(entry.id, depth);
	}
	return depths;
};

const getEntryPreviewContent = (entry: SessionHistoryTreeEntry): string => {
	switch (entry.kind) {
		case "record":
			return getRecordText(entry).slice(0, MAX_PREVIEW_LENGTH);
		case "plugin-state":
			return "Plugin State payload is intentionally hidden from the history preview.";
		case "plugin-entry":
			return "Plugin history payload is intentionally hidden from the history preview.";
		default:
			return getEntrySummary(entry);
	}
};

const getEntryPreviewTitle = (entry: SessionHistoryTreeEntry): string => {
	switch (entry.kind) {
		case "record":
			return `Record ${entry.recordId}`;
		case "plugin-state":
			return getPluginStateEntryTitle(entry);
		case "plugin-entry":
			return getPluginHistoryEntryTitle(entry);
		default:
			return getEntrySummary(entry);
	}
};

function SessionHistoryEntryPreview({
	entry,
}: {
	readonly entry: SessionHistoryTreeEntry;
}) {
	useDialogEscape();
	const { colors } = useTheme();
	const content = getEntryPreviewContent(entry);
	const title = getEntryPreviewTitle(entry);
	return (
		<box flexDirection="column" gap={1} paddingX={1}>
			<text attributes={TextAttributes.BOLD} fg={colors.text}>
				{title}
			</text>
			<text fg={colors.textMuted}>
				{`Sequence ${entry.sequence} · ${entry.selectedPath ? "Selected Path" : "inactive branch"}`}
			</text>
			<text fg={colors.text}>
				{content.length === 0
					? "No plain-text content in this entry."
					: content}
			</text>
		</box>
	);
}

export function SessionHistoryTreeDialogContent({
	isRewindDisabled = false,
	onForkCheckpoint,
	onRewindCheckpoint,
	sessionId,
	sessionSdk,
}: SessionHistoryTreeDialogContentProps) {
	const dialog = useDialog();
	const { height } = useTerminalDimensions();
	useDialogEscape();
	const { colors } = useTheme();
	const [entries, setEntries] = useState<readonly SessionHistoryTreeEntry[]>(
		[]
	);
	const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
	const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string>();
	const nextCursorRef = useRef<string | undefined>(undefined);
	const loadingMoreRef = useRef(false);
	const navigationPendingRef = useRef(false);
	const actionPendingRef = useRef(false);
	const [forkedSessionId, setForkedSessionId] = useState<SessionId>();
	// Reserve dialog chrome, action/help rows, the history-behavior note, and
	// visible status rows before budgeting two terminal rows per history item.
	const statusRows =
		(error === undefined ? 0 : 1) + (forkedSessionId === undefined ? 0 : 2);
	const actionHelpRows =
		(onForkCheckpoint === undefined ? 0 : 1) +
		(onRewindCheckpoint === undefined ? 0 : 1) +
		2;
	const maxVisibleItems = Math.max(
		1,
		Math.min(
			8,
			Math.floor(
				(height - DIALOG_CHROME_ROWS - actionHelpRows - statusRows) / 2
			)
		)
	);
	const depths = useMemo(() => getEntryDepths(entries), [entries]);

	useEffect(() => {
		let active = true;
		setEntries([]);
		setActiveLeafId(null);
		setNextCursor(undefined);
		setError(undefined);
		setLoading(true);
		nextCursorRef.current = undefined;
		void sessionSdk
			.readSessionHistoryTreePage(sessionId, { limit: HISTORY_PAGE_SIZE })
			.then((page) => {
				if (!active) {
					return;
				}
				setEntries(page.entries);
				setActiveLeafId(page.activeLeafId);
				setNextCursor(page.nextCursor);
				nextCursorRef.current = page.nextCursor;
			})
			.catch((loadError: unknown) => {
				if (active) {
					setError(
						loadError instanceof Error
							? loadError.message
							: "Could not read Session history."
					);
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [sessionId, sessionSdk]);

	const loadMore = useCallback(async () => {
		const cursor = nextCursorRef.current;
		if (cursor === undefined || loadingMoreRef.current) {
			return;
		}
		loadingMoreRef.current = true;
		setLoadingMore(true);
		setError(undefined);
		try {
			const page: SessionHistoryTreePage =
				await sessionSdk.readSessionHistoryTreePage(sessionId, {
					cursor,
					limit: HISTORY_PAGE_SIZE,
				});
			setEntries((current) => [...current, ...page.entries]);
			setActiveLeafId(page.activeLeafId);
			setNextCursor(page.nextCursor);
			nextCursorRef.current = page.nextCursor;
		} catch (loadError) {
			setError(
				loadError instanceof Error
					? loadError.message
					: "Could not read more Session history."
			);
		} finally {
			loadingMoreRef.current = false;
			setLoadingMore(false);
		}
	}, [sessionId, sessionSdk]);

	const openPreview = useCallback(
		(entry: SessionHistoryTreeEntry) => {
			dialog.open({
				children: <SessionHistoryEntryPreview entry={entry} />,
				title: `History entry ${entry.sequence}`,
				width: 72,
			});
		},
		[dialog]
	);
	const navigateTo = useCallback(
		async (targetEntryId: SessionHistoryTreeEntry["id"] | null) => {
			if (navigationPendingRef.current) {
				return;
			}
			navigationPendingRef.current = true;
			setError(undefined);
			try {
				const outcome = await sessionSdk.navigateSessionHistory(sessionId, {
					operationId: randomUUIDv7(),
					targetEntryId,
				});
				if (outcome.kind === "navigated" || outcome.kind === "unchanged") {
					dialog.close();
					return;
				}
				setError(outcome.reason);
			} catch (navigationError) {
				setError(
					navigationError instanceof Error
						? navigationError.message
						: "Could not navigate Session history."
				);
			} finally {
				navigationPendingRef.current = false;
			}
		},
		[dialog, sessionId, sessionSdk]
	);
	const navigateToEntry = useCallback(
		(entry: SessionHistoryTreeEntry) => {
			void navigateTo(entry.id);
		},
		[navigateTo]
	);
	const forkSelectedRecord = useCallback(
		async (entry: SessionHistoryTreeEntry) => {
			if (entry.kind !== "record") {
				setError("Fork and Rewind require a Record checkpoint.");
				return;
			}
			if (onForkCheckpoint === undefined) {
				setError("Fork is unavailable in this Session view.");
				return;
			}
			if (actionPendingRef.current || navigationPendingRef.current) {
				return;
			}
			actionPendingRef.current = true;
			setError(undefined);
			setForkedSessionId(undefined);
			try {
				setForkedSessionId(await onForkCheckpoint(entry.recordId));
			} catch (forkError) {
				setError(getErrorMessage(forkError, "Could not fork this checkpoint."));
			} finally {
				actionPendingRef.current = false;
			}
		},
		[onForkCheckpoint]
	);
	const rewindSelectedRecord = useCallback(
		async (entry: SessionHistoryTreeEntry) => {
			if (entry.kind !== "record") {
				setError("Fork and Rewind require a Record checkpoint.");
				return;
			}
			if (onRewindCheckpoint === undefined) {
				setError("Rewind is unavailable in this Session view.");
				return;
			}
			if (isRewindDisabled) {
				setError(
					"Rewind is unavailable while the Session is active or compacting."
				);
				return;
			}
			if (actionPendingRef.current || navigationPendingRef.current) {
				return;
			}
			actionPendingRef.current = true;
			setError(undefined);
			try {
				await onRewindCheckpoint(entry.recordId);
				dialog.close();
			} catch (rewindError) {
				setError(
					getErrorMessage(rewindError, "Could not rewind this checkpoint.")
				);
			} finally {
				actionPendingRef.current = false;
			}
		},
		[dialog, isRewindDisabled, onRewindCheckpoint]
	);
	const handleNavigationKey = (key: HistoryTreeKey): boolean => {
		if (
			(navigationPendingRef.current || actionPendingRef.current) &&
			(key.name === "enter" ||
				key.name === "return" ||
				(key.ctrl && key.name === "home"))
		) {
			return true;
		}
		if (
			key.ctrl &&
			key.name === "down" &&
			nextCursorRef.current !== undefined
		) {
			void loadMore();
			return true;
		}
		return false;
	};
	const handleEntryKey = (
		key: HistoryTreeKey,
		entry: SessionHistoryTreeEntry | undefined
	): boolean => {
		if (key.ctrl && key.name === "home") {
			void navigateTo(null);
			return true;
		}
		if (entry === undefined) {
			return false;
		}
		if (key.name === "p") {
			openPreview(entry);
			return true;
		}
		if (key.name === "f" && onForkCheckpoint !== undefined) {
			void forkSelectedRecord(entry);
			return true;
		}
		if (key.name === "r" && onRewindCheckpoint !== undefined) {
			void rewindSelectedRecord(entry);
			return true;
		}
		return false;
	};
	const handleHistoryKey = (
		key: HistoryTreeKey,
		entry: SessionHistoryTreeEntry | undefined,
		isSearching: boolean
	): boolean => {
		if (handleNavigationKey(key)) {
			return true;
		}
		return isSearching ? false : handleEntryKey(key, entry);
	};
	const currentLeaf = entries.find((entry) => entry.id === activeLeafId);
	let leafLabel = "Current leaf: empty Session";
	if (activeLeafId !== null) {
		leafLabel =
			currentLeaf === undefined
				? "Current leaf is on a later page"
				: `Current leaf: entry ${currentLeaf.sequence}`;
	}

	return (
		<box flexDirection="column" gap={1}>
			<text fg={colors.textMuted}>
				Enter selects a history entry within this Session · p previews ·
				Ctrl+Home selects root · L marks the current leaf
			</text>
			{onForkCheckpoint === undefined ? null : (
				<text fg={colors.textMuted}>
					f forks the selected Record as a new Session.
				</text>
			)}
			{onRewindCheckpoint === undefined ? null : (
				<text fg={colors.textMuted}>
					{`r rewinds by forking and opening the new Session${isRewindDisabled ? " (disabled while active)" : ""}.`}
				</text>
			)}
			<text fg={colors.textMuted}>
				History actions do not roll back workspace files or replay Tool Calls.
			</text>
			<text fg={colors.primary}>{leafLabel}</text>
			{forkedSessionId === undefined ? null : (
				<text fg={colors.primary} id="history-tree-fork-result">
					{`Fork created: Session ${forkedSessionId}. Source Session remains open.`}
				</text>
			)}
			{error === undefined ? null : (
				<text fg={colors.error} id="history-tree-action-error">
					{error}
				</text>
			)}
			<SearchListDialogWrapper
				emptyText={
					loading ? "Loading Session history..." : "No history entries"
				}
				footerHints={
					<>
						<DialogFooterHint label="select" shortcut="enter" />
						{onForkCheckpoint === undefined ? null : (
							<DialogFooterHint label="fork Record" shortcut="f" />
						)}
						{onRewindCheckpoint === undefined ? null : (
							<DialogFooterHint label="rewind" shortcut="r" />
						)}
						<DialogFooterHint label="preview" shortcut="p" />
						<DialogFooterHint label="root" shortcut="ctrl+home" />
						{nextCursor === undefined ? null : (
							<DialogFooterHint
								label={loadingMore ? "loading" : "load more"}
								shortcut="ctrl+↓"
							/>
						)}
						<DialogFooterHint label="close" shortcut="esc" />
					</>
				}
				getKey={(entry) => `${entry.sequence}:${entry.id}`}
				getSearchText={getEntrySummary}
				initialSelectedIndex={Math.max(
					0,
					entries.findIndex((entry) => entry.id === activeLeafId)
				)}
				isItemActive={(entry) => entry.id === activeLeafId}
				items={entries}
				maxVisibleItems={maxVisibleItems}
				onKey={handleHistoryKey}
				onSelect={navigateToEntry}
				placeholder="Search Session history"
				renderItem={(entry, _isSelected, isActive) => {
					let marker = entry.selectedPath ? "|" : " ";
					if (isActive) {
						marker = "L";
					}
					const indent = "  ".repeat(depths.get(entry.id) ?? 0);
					return (
						<text
							attributes={isActive ? TextAttributes.BOLD : undefined}
							fg={
								entry.kind === "plugin-state" || entry.kind === "plugin-entry"
									? colors.textMuted
									: colors.text
							}
							selectable={false}
						>
							{`${indent}${marker} ${getEntrySummary(entry)}`}
						</text>
					);
				}}
			/>
		</box>
	);
}

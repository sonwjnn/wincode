import { TextAttributes } from "@opentui/core";
import type { SessionWriterLockOwner } from "@/modules/sessions/storage/session-writer-lock";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionCompaction } from "../../compaction/types";
import type { SessionMessage } from "../../message";
import { ChatMessage } from "../components/chat-message";
import { buildSessionTimeline } from "../components/chat-timeline";
import { resolveSessionTurnFooterMessages } from "../components/chat-turns";
import { CompactionDivider } from "../components/compaction-divider";
import {
	SessionWriterAction,
	SessionWriterOwnerLabel,
} from "../components/session-writer-controls";

type StoredSessionHistoryViewProps = Readonly<{
	compactions: readonly SessionCompaction[];
	isRefreshing: boolean;
	isRetrying: boolean;
	isSelectingModel: boolean;
	messages: readonly SessionMessage[];
	onRefresh: () => void;
	onRetry: () => void;
	onReselectModel: () => void;
	owner: SessionWriterLockOwner | undefined;
	selectionError?: string;
	selectionPickerError?: string;
	sessionTitle: string;
}>;

export function StoredSessionHistoryView({
	compactions,
	isRefreshing,
	isRetrying,
	isSelectingModel,
	messages,
	onRefresh,
	onRetry,
	onReselectModel,
	owner,
	selectionError,
	selectionPickerError,
	sessionTitle,
}: StoredSessionHistoryViewProps) {
	const { colors } = useTheme();
	const timeline = buildSessionTimeline(messages, compactions);
	const turns = timeline.flatMap((item) =>
		item.kind === "turn" ? [item.turn] : []
	);
	const footerMessages = resolveSessionTurnFooterMessages(turns);
	const isBusy = isRefreshing || isRetrying || isSelectingModel;

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			height="100%"
			paddingX={1}
			width="100%"
		>
			<box flexDirection="column" gap={1} paddingY={1} width="100%">
				<text attributes={TextAttributes.BOLD} fg={colors.text}>
					Stored Session History · Read-only
				</text>
				{selectionError === undefined ? (
					<>
						<text fg={colors.textMuted}>
							A writer lock is held. This view cannot change that session.
						</text>
						<SessionWriterOwnerLabel owner={owner} />
					</>
				) : (
					<>
						<text fg={colors.error}>{selectionError}</text>
						<text fg={colors.textMuted}>
							This history remains read-only until you choose a Provider Model
							again.
						</text>
					</>
				)}
				{selectionPickerError === undefined ? null : (
					<text fg={colors.error}>{selectionPickerError}</text>
				)}
				<text fg={colors.text}>{sessionTitle}</text>
				<box flexDirection="row" gap={2}>
					<SessionWriterAction
						disabled={isBusy}
						id="stored-session-history-refresh"
						label={isRefreshing ? "Refreshing history..." : "Refresh history"}
						onActivate={onRefresh}
					/>
					{selectionError === undefined ? (
						<SessionWriterAction
							disabled={isBusy}
							id="stored-session-history-open"
							label={
								isRetrying
									? "Opening for editing..."
									: "Retry / Open for editing"
							}
							onActivate={onRetry}
						/>
					) : (
						<SessionWriterAction
							disabled={isBusy}
							id="stored-session-history-reselect-model"
							label={
								isSelectingModel
									? "Loading Provider Models..."
									: "Reselect Provider Model to continue"
							}
							onActivate={onReselectModel}
						/>
					)}
				</box>
			</box>
			<scrollbox
				flexGrow={1}
				height="100%"
				id="stored-session-history-scrollbox"
				stickyScroll
				stickyStart="bottom"
				verticalScrollbarOptions={{ visible: false }}
			>
				<box flexDirection="column" gap={1}>
					{timeline.length === 0 ? (
						<text fg={colors.textMuted}>No saved messages.</text>
					) : (
						timeline.map((item, index) => {
							if (item.kind === "compaction") {
								return (
									<CompactionDivider
										entry={item.compaction}
										key={item.compaction.id}
									/>
								);
							}
							return (
								<box
									key={item.turn.id}
									marginTop={index === 0 ? 1 : 0}
									width="100%"
								>
									<ChatMessage
										footerMessage={footerMessages.get(item.turn.id)}
										messages={item.turn.messages}
									/>
								</box>
							);
						})
					)}
				</box>
			</scrollbox>
		</box>
	);
}

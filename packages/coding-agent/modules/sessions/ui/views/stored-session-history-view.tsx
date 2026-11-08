import { TextAttributes } from "@opentui/core";
import type { SessionWriterLockOwner } from "@/modules/sessions/storage/session-writer-lock";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type { SessionCompaction } from "../../compaction/types";
import type { SessionMessage } from "../../message";
import type { SessionForkProvenance } from "../../storage/session-store";
import type {
	SessionStatistics,
	SessionStatisticsUsageTotals,
} from "../../usage/session-statistics";
import { ChatMessage } from "../components/chat-message";
import { buildSessionTimeline } from "../components/chat-timeline";
import { resolveSessionTurnFooterMessages } from "../components/chat-turns";
import { CompactionDivider } from "../components/compaction-divider";
import { SessionForkProvenanceBanner } from "../components/session-fork-provenance-banner";
import {
	SessionWriterAction,
	SessionWriterOwnerLabel,
} from "../components/session-writer-controls";

type StoredSessionHistoryViewProps = Readonly<{
	compactions: readonly SessionCompaction[];
	forkProvenance?: SessionForkProvenance;
	hasMoreHistory: boolean;
	historyError?: string;
	isLoadingMore: boolean;
	isRefreshing: boolean;
	isRetrying: boolean;
	isSelectingModel: boolean;
	messages: readonly SessionMessage[];
	onLoadMore: () => void;
	onRefresh: () => void;
	onRetry: () => void;
	onReselectModel: () => void;
	owner: SessionWriterLockOwner | undefined;
	selectionError?: string;
	selectionPickerError?: string;
	sessionTitle: string;
	statistics: SessionStatistics;
}>;

export function StoredSessionHistoryView({
	compactions,
	forkProvenance,
	hasMoreHistory,
	historyError,
	isLoadingMore,
	isRefreshing,
	isRetrying,
	isSelectingModel,
	messages,
	onLoadMore,
	onRefresh,
	onRetry,
	onReselectModel,
	owner,
	selectionError,
	selectionPickerError,
	sessionTitle,
	statistics,
}: StoredSessionHistoryViewProps) {
	const { colors } = useTheme();
	const timeline = buildSessionTimeline(messages, compactions);
	const turns = timeline.flatMap((item) =>
		item.kind === "turn" ? [item.turn] : []
	);
	const footerMessages = resolveSessionTurnFooterMessages(turns);
	const isBusy =
		isRefreshing || isRetrying || isSelectingModel || isLoadingMore;
	const costLabel = (usage: SessionStatisticsUsageTotals): string => {
		const recordedCosts = usage.costs.map(
			({ amount, model, unit }) =>
				`${model.providerId}/${model.modelId}: ${amount} ${unit}`
		);
		if (usage.unknownCostCount > 0) {
			recordedCosts.push(`${usage.unknownCostCount} cost unknown`);
		}
		if (recordedCosts.length > 0) {
			return recordedCosts.join(", ");
		}
		return usage.contributionCount === 0
			? "no persisted usage"
			: "cost unknown";
	};
	const usageLabel = (
		label: string,
		usage: SessionStatisticsUsageTotals
	): string =>
		usage.contributionCount === 0
			? `${label}: no persisted usage`
			: `${label}: ${usage.inputTokens ?? "unknown"} input / ${usage.outputTokens ?? "unknown"} output tokens; ${costLabel(usage)}`;

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
				{forkProvenance === undefined ? null : (
					<SessionForkProvenanceBanner
						inheritedUsage={statistics.usage.inherited}
						provenance={forkProvenance}
					/>
				)}
				<text fg={colors.textMuted}>
					{`Persisted statistics · read point ${statistics.readPoint.slice(0, 12)}… · ${statistics.recordCount} committed records · ${statistics.completedToolCallCount} completed Tool Calls`}
				</text>
				<text fg={colors.textMuted}>
					{usageLabel("Actual", statistics.usage.actual)}
				</text>
				<text fg={colors.textMuted}>
					Inherited usage is historical source spend, not new spend in this
					Session.
				</text>
				<text fg={colors.textMuted}>
					{usageLabel("Inherited", statistics.usage.inherited)}
				</text>
				<text fg={colors.textMuted}>
					{usageLabel("Auxiliary", statistics.usage.auxiliary)}
				</text>
				<box flexDirection="row" gap={2}>
					{hasMoreHistory ? (
						<SessionWriterAction
							disabled={isBusy}
							id="stored-session-history-load-more"
							label={
								isLoadingMore
									? "Loading older history..."
									: "Load older history"
							}
							onActivate={onLoadMore}
						/>
					) : null}
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
				{historyError === undefined ? null : (
					<text fg={colors.error}>{historyError}</text>
				)}
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

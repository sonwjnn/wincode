import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
	AgentId,
	ModelRetryStatus,
	SessionMessageId,
	SessionRecordId,
} from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai";
import { isUndefined } from "@wincode/utils";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import type { CacheWarmingStatus } from "@/modules/prompt-cache/cache-warming";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import type { InteractiveProviderController } from "@/modules/providers/interactive-provider-controller";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionForkCheckpointAssessment } from "@/modules/sessions/session-fork-checkpoint-validation";
import type { SessionUsageEntry } from "@/modules/sessions/storage/session-store";
import {
	AUTO_COMPACT_SETTING,
	useSettingRegistryValue,
} from "@/modules/settings";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import {
	useKeyboardLayer,
	useToggleShortcut,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	getThinkingLevelBorderColor,
	getThinkingLevelColor,
} from "@/shared/providers/theme/themes";
import { useSessionNotifications } from "@/shared/providers/toast/toast-provider";
import type {
	UiNotification,
	UiNotificationAnchor,
} from "@/shared/providers/toast/types";
import { Spinner } from "@/shared/ui/spinner";
import { useUiComponentFocus } from "@/shared/ui/ui-component-registry";
import type { SessionQueuedSubmission } from "../../agent-session/types";
import {
	isCompactionSummaryMessage,
	type SessionCompaction,
} from "../../compaction";
import type { PromptHistoryEntry } from "../../hooks/input-controller/history";
import { summarizeSessionUsage } from "../../usage/session-usage";
import type { ChatPromptComposition, ChatPromptSubmission } from "../../utils";
import {
	ErrorMessage,
	repeatsTerminalError,
	type SessionErrorSource,
} from "../messages";
import { ChatMessage, ChatNotificationMessage } from "./chat-message";
import { ChatTextArea } from "./chat-text-area";
import {
	buildSessionTranscriptTimeline,
	type SessionTimelineItem,
} from "./chat-timeline";
import {
	groupMessagesBySessionTurn,
	resolveRetryMessageId,
	resolveSessionTurnFooterMessages,
} from "./chat-turns";
import { CompactionDivider } from "./compaction-divider";
import { CompactionStatus } from "./compaction-status";
import { ModelRetryIndicator } from "./model-retry-status";
import { SessionUsageBar } from "./session-usage-bar";
import { WaitingMessageStrip } from "./waiting-message-strip";
import { WorkspacePath } from "./workspace-path";

const EMPTY_QUEUED_SUBMISSIONS: readonly SessionQueuedSubmission[] = [];

type ChatShellProps = {
	activeMessages?: readonly SessionMessage[];
	forkCheckpoints?: ReadonlyMap<
		SessionMessageId,
		SessionForkCheckpointAssessment
	>;
	rewindingCheckpointId?: SessionRecordId;
	onRewindCheckpoint?: (recordId: SessionRecordId) => void | Promise<void>;
	compactions?: readonly SessionCompaction[];
	draftKey?: string;
	error?: unknown;
	/** Only a turn error can duplicate a terminal assistant error; other sources remain visible. */
	errorSource?: SessionErrorSource;
	isBusy: boolean;
	isSelectionReady?: boolean;
	isCompacting: boolean;
	messages: readonly SessionMessage[];
	onCompact?: (focus?: string) => Promise<boolean> | boolean;
	onProviderModelChanged?: () => void;
	onOpenSettings?: (section?: string) => Promise<void> | void;
	onOpenSessionHistory?: () => Promise<void> | void;
	providerController?: InteractiveProviderController;
	onRetry?: (messageId: SessionMessageId) => void | Promise<void>;
	promptHistory: PromptHistoryEntry[];
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | undefined;
	onEmptySubmit?: () => void | Promise<void>;
	/** Waiting submissions, oldest first; the strip shows them while they wait. */
	queuedSubmissions?: readonly SessionQueuedSubmission[];
	/** Compositions a Recall returned, waiting to enter the composer. */
	recalledSubmissions?: readonly ChatPromptComposition[];
	/** Changes whenever `recalledSubmissions` holds something new to restore. */
	recallRevision?: number;
	viewId: string;
	sessionUsageEntries?: readonly SessionUsageEntry[];
	cacheWarmingStatus?: CacheWarmingStatus;
	retryStatus?: ModelRetryStatus;
	retryOperation?: "agent-turn" | "compaction-summary";
	contextSnapshot?: ConfigSnapshot;
	/** Rendered at the bottom of the transcript; the shell never persists it. */
	transcriptNotice?: ReactNode;
};
function ActivityFooter({
	accentColor,
	agent,
	autoCompact,
	isCompacting,
	retryStatus,
	retryOperation,
}: {
	accentColor: string;
	agent: AgentId;
	autoCompact: boolean;
	isCompacting: boolean;
	retryStatus?: ModelRetryStatus;
	retryOperation?: "agent-turn" | "compaction-summary";
}) {
	if (retryStatus !== undefined) {
		return (
			<ModelRetryIndicator
				agent={agent}
				operation={retryOperation}
				status={retryStatus}
			/>
		);
	}
	const compactionLabel = autoCompact ? "Auto-compacting..." : "Compacting...";
	return (
		<box alignItems="center" flexDirection="row" gap={1}>
			<Spinner agent={agent} color={accentColor} />
			<text fg={accentColor}>
				{isCompacting ? compactionLabel : "Working..."}
			</text>
		</box>
	);
}
const TRANSCRIPT_NOTICE = Symbol("transcript-notice");

type TranscriptEntry =
	| SessionTimelineItem
	| { kind: "notification"; notification: UiNotification }
	| typeof TRANSCRIPT_NOTICE;

/**
 * Slots the transient notice after every message that existed when it first
 * appeared, so messages arriving later read below it instead of pushing it
 * down. The notice is never persisted: a fresh mount captures the anchor again
 * and renders it at the end of the loaded transcript.
 */
function SessionFooterStatuses({ scope }: { scope: string }) {
	const { statuses } = useSessionNotifications(scope);
	const { colors } = useTheme();
	if (statuses.length === 0) {
		return null;
	}
	return (
		<box flexDirection="column" paddingX={1} width="100%">
			{statuses.map(({ key, message }) => (
				<text fg={colors.textMuted} key={key} width="100%" wrapMode="word">
					{message}
				</text>
			))}
		</box>
	);
}

const resolveNoticeSlot = (
	timeline: readonly SessionTimelineItem[],
	anchorMessageCount: number | undefined
): number => {
	if (anchorMessageCount === undefined) {
		return timeline.length;
	}
	let seen = 0;
	for (const [index, item] of timeline.entries()) {
		if (seen >= anchorMessageCount) {
			return index;
		}
		if (item.kind === "turn") {
			seen += item.turn.messages.length;
		}
	}
	return timeline.length;
};

const resolveNotificationSlot = (
	timeline: readonly SessionTimelineItem[],
	anchor: UiNotificationAnchor | undefined
): number => {
	if (anchor === undefined) {
		return timeline.length;
	}
	const currentMessageCount = timeline.reduce(
		(count, item) =>
			item.kind === "turn" ? count + item.turn.messages.length : count,
		0
	);
	if (
		anchor.afterCompactionId !== undefined &&
		currentMessageCount === anchor.messageCount
	) {
		const compactionIndex = timeline.findIndex(
			(item) =>
				item.kind === "compaction" &&
				item.compaction.id === anchor.afterCompactionId
		);
		if (compactionIndex !== -1) {
			return compactionIndex + 1;
		}
	}
	return resolveNoticeSlot(timeline, anchor.messageCount);
};

const partitionNotificationsByMessage = (
	notifications: readonly UiNotification[],
	messages: readonly SessionMessage[]
): {
	notificationsByMessageId: Map<string, UiNotification[]>;
	timelineNotifications: UiNotification[];
} => {
	const messageIds = new Set<string>(messages.map(({ id }) => id));
	const notificationsByMessageId = new Map<string, UiNotification[]>();
	const timelineNotifications: UiNotification[] = [];
	for (const notification of notifications) {
		const messageId = notification.anchor?.afterMessageId;
		if (messageId === undefined || !messageIds.has(messageId)) {
			timelineNotifications.push(notification);
			continue;
		}
		const anchoredNotifications = notificationsByMessageId.get(messageId) ?? [];
		anchoredNotifications.push(notification);
		notificationsByMessageId.set(messageId, anchoredNotifications);
	}
	return { notificationsByMessageId, timelineNotifications };
};

const buildTranscriptEntries = (
	timeline: readonly SessionTimelineItem[],
	notifications: readonly UiNotification[],
	noticeAnchorMessageCount: number | undefined
): readonly TranscriptEntry[] => {
	const entriesAtSlot = new Map<number, TranscriptEntry[]>();
	const appendAtSlot = (slot: number, entry: TranscriptEntry): void => {
		const entries = entriesAtSlot.get(slot) ?? [];
		entries.push(entry);
		entriesAtSlot.set(slot, entries);
	};

	if (noticeAnchorMessageCount !== undefined) {
		appendAtSlot(
			resolveNoticeSlot(timeline, noticeAnchorMessageCount),
			TRANSCRIPT_NOTICE
		);
	}
	for (const notification of notifications) {
		appendAtSlot(resolveNotificationSlot(timeline, notification.anchor), {
			kind: "notification",
			notification,
		});
	}

	const transcriptEntries: TranscriptEntry[] = [];
	for (let slot = 0; slot <= timeline.length; slot++) {
		transcriptEntries.push(...(entriesAtSlot.get(slot) ?? []));
		const item = timeline[slot];
		if (item !== undefined) {
			transcriptEntries.push(item);
		}
	}
	return transcriptEntries;
};

export function ChatShell({
	activeMessages,
	forkCheckpoints,
	rewindingCheckpointId,
	onRewindCheckpoint,
	compactions = [],
	draftKey,
	error,
	errorSource,
	isBusy,
	isSelectionReady,
	isCompacting,
	messages,
	onCompact,
	onProviderModelChanged,
	onOpenSettings,
	onOpenSessionHistory,
	providerController,
	onRetry,
	promptHistory,
	onSubmit,
	onEmptySubmit,
	queuedSubmissions = EMPTY_QUEUED_SUBMISSIONS,
	recalledSubmissions,
	recallRevision,
	viewId,
	sessionUsageEntries = [],
	cacheWarmingStatus = "idle",
	retryStatus,
	retryOperation,
	contextSnapshot,
	transcriptNotice,
}: ChatShellProps) {
	const scrollboxRef = useRef<ScrollBoxRenderable>(null);
	const focusScopeId = `chat-shell-${viewId}`;
	const composerId = `${focusScopeId}-composer`;
	const transcriptId = `${focusScopeId}-transcript`;
	const backgroundComponentIds = useMemo(() => [transcriptId], [transcriptId]);
	const { isTopLayer } = useKeyboardLayer();
	const [scrollRequest, setScrollRequest] = useState(0);
	const [showActions, setShowActions] = useState(false);
	useEffect(() => {
		if (isBusy) {
			setShowActions(false);
		}
	}, [isBusy]);
	const { agent, model, thinkingLevel } = usePromptConfig();
	const { colors } = useTheme();
	const { notifications } = useSessionNotifications(viewId);
	const isComposerFocused = isTopLayer("base") || isTopLayer("command");
	const defaultComposerBorderColor = isComposerFocused
		? colors.borderActive
		: colors.border;
	const composerBorderColor =
		thinkingLevel === undefined
			? defaultComposerBorderColor
			: getThinkingLevelBorderColor(colors, thinkingLevel);
	const activityAccentColor =
		thinkingLevel === undefined
			? defaultComposerBorderColor
			: getThinkingLevelColor(colors, thinkingLevel);
	const autoCompactSetting = useSettingRegistryValue(AUTO_COMPACT_SETTING);
	const autoCompact =
		autoCompactSetting.status === "ready" && autoCompactSetting.value;
	const subscribeProviderComposition = useCallback(
		(listener: () => void) =>
			providerController?.subscribeComposition?.(listener) ?? (() => undefined),
		[providerController]
	);
	const getProviderCompositionRevision = useCallback(
		() => providerController?.getCompositionRevision?.() ?? 0,
		[providerController]
	);
	const providerCompositionRevision = useSyncExternalStore(
		subscribeProviderComposition,
		getProviderCompositionRevision,
		getProviderCompositionRevision
	);
	const subscribeProviderAvailability = useCallback(
		(listener: () => void) =>
			providerController?.subscribeAvailability?.(listener) ??
			(() => undefined),
		[providerController]
	);
	const getProviderAvailabilityRevision = useCallback(
		() => providerController?.getAvailabilityRevision?.() ?? 0,
		[providerController]
	);
	const providerAvailabilityRevision = useSyncExternalStore(
		subscribeProviderAvailability,
		getProviderAvailabilityRevision,
		getProviderAvailabilityRevision
	);
	const [providerModels, setProviderModels] = useState<
		readonly ProviderModel[] | undefined
	>(() => (providerController === undefined ? undefined : []));
	useEffect(() => {
		if (providerController === undefined) {
			setProviderModels(undefined);
			return;
		}
		let active = true;
		const requestedCompositionRevision = providerCompositionRevision;
		const requestedAvailabilityRevision = providerAvailabilityRevision;
		const isCurrentRevision = () =>
			getProviderCompositionRevision() === requestedCompositionRevision &&
			getProviderAvailabilityRevision() === requestedAvailabilityRevision;
		void providerController
			.getKnownModels()
			.then((models) => {
				if (active && isCurrentRevision()) {
					setProviderModels(models);
				}
			})
			.catch(() => {
				if (active && isCurrentRevision()) {
					setProviderModels([]);
				}
			});
		return () => {
			active = false;
		};
	}, [
		getProviderAvailabilityRevision,
		getProviderCompositionRevision,
		providerAvailabilityRevision,
		providerCompositionRevision,
		providerController,
	]);
	const focusHandlers = useUiComponentFocus({
		backgroundComponentIds,
		componentId: composerId,
		enabled: true,
		scopeId: focusScopeId,
	});
	const displayMessages = messages.filter(
		(message) => !isCompactionSummaryMessage(message)
	);
	const isRepeatedTerminalError = repeatsTerminalError(
		error,
		displayMessages,
		errorSource
	);
	const turns = groupMessagesBySessionTurn(displayMessages);
	const transcriptTimeline = buildSessionTranscriptTimeline(
		messages,
		compactions
	);
	const { notificationsByMessageId, timelineNotifications } =
		partitionNotificationsByMessage(notifications, displayMessages);
	const hasTranscriptNotice =
		transcriptNotice !== undefined && transcriptNotice !== null;
	const [hadTranscriptNotice, setHadTranscriptNotice] = useState(false);
	const [noticeAnchorMessageCount, setNoticeAnchorMessageCount] = useState<
		number | undefined
	>(undefined);
	if (hasTranscriptNotice !== hadTranscriptNotice) {
		// Capture the anchor in the same commit that first shows the notice, so
		// messages arriving later cannot slip behind it.
		setHadTranscriptNotice(hasTranscriptNotice);
		setNoticeAnchorMessageCount(
			hasTranscriptNotice ? displayMessages.length : undefined
		);
	}
	const transcriptEntries = buildTranscriptEntries(
		transcriptTimeline,
		timelineNotifications,
		hasTranscriptNotice ? noticeAnchorMessageCount : undefined
	);
	const footerMessages = resolveSessionTurnFooterMessages(turns);
	const retryableMessages = activeMessages ?? displayMessages;
	const canRetryMessage = (messageId: SessionMessageId): boolean =>
		retryableMessages.some(({ id }) => id === messageId) ||
		displayMessages.some(
			(message) =>
				message.id === messageId &&
				message.role === "user" &&
				message.metadata?.submissionStatus === "failed" &&
				message.metadata.submissionId !== undefined
		);
	const latestRetryMessageId = resolveRetryMessageId(displayMessages);
	const canRetry =
		!(isBusy || isUndefined(latestRetryMessageId)) &&
		canRetryMessage(latestRetryMessageId) &&
		!isUndefined(onRetry);
	// The durable ledger includes successful and failed summary attempts;
	// compaction records repeat successful usage and would inflate session totals.
	const usage = useMemo(
		() =>
			summarizeSessionUsage(
				displayMessages,
				model,
				sessionUsageEntries,
				cacheWarmingStatus,
				providerModels,
				[],
				activeMessages ?? displayMessages,
				contextSnapshot
			),
		[
			displayMessages,
			activeMessages,
			model,
			sessionUsageEntries,
			cacheWarmingStatus,
			providerModels,
			contextSnapshot,
		]
	);
	useEffect(() => {
		if (scrollRequest === 0) {
			return;
		}

		scrollboxRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
	}, [scrollRequest]);
	useToggleShortcut("ctrl+o", () => {
		setScrollRequest((request) => request + 1);
	});
	useKeyboard((key) => {
		if (
			isTopLayer("base") &&
			(key.option || key.meta) &&
			key.name === "w" &&
			!isBusy
		) {
			key.preventDefault();
			setShowActions((visible) => !visible);
			return;
		}
		if (
			!canRetry ||
			isUndefined(latestRetryMessageId) ||
			isUndefined(onRetry) ||
			!isTopLayer("base") ||
			!(key.option || key.meta) ||
			key.name !== "r"
		) {
			return;
		}
		key.preventDefault();
		void onRetry(latestRetryMessageId);
	});

	const handleSubmit = async (
		submission: ChatPromptSubmission
	): Promise<boolean> => {
		const accepted = await onSubmit(submission);
		if (accepted === false) {
			return false;
		}
		setShowActions(false);
		setScrollRequest((request) => request + 1);
		return true;
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse events.
		<box
			flexDirection="column"
			flexGrow={1}
			height="100%"
			id={focusScopeId}
			onMouseDown={focusHandlers.onMouseDown}
			onMouseMove={focusHandlers.onMouseMove}
			paddingTop={0}
			paddingX={0}
			width="100%"
		>
			<scrollbox
				flexGrow={1}
				height="100%"
				id={transcriptId}
				ref={scrollboxRef}
				stickyScroll
				stickyStart="bottom"
				verticalScrollbarOptions={{ visible: false }}
			>
				<box flexDirection="column" gap={1}>
					{displayMessages.length === 0 && !error ? (
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							No messages yet.
						</text>
					) : null}
					{transcriptEntries.map((entry) => {
						if (entry === TRANSCRIPT_NOTICE) {
							return (
								<box key="transcript-notice" paddingX={1} width="100%">
									{transcriptNotice}
								</box>
							);
						}
						if (entry.kind === "notification") {
							return (
								<ChatNotificationMessage
									key={`session-notification-${entry.notification.id}`}
									notification={entry.notification}
								/>
							);
						}
						const item = entry;
						if (item.kind === "compaction") {
							return (
								<CompactionDivider
									entry={item.compaction}
									key={item.compaction.id}
								/>
							);
						}
						const turn = item.turn;
						const turnRetryMessageId = resolveRetryMessageId(turn.messages);
						const canRetryTurn =
							!(isBusy || isUndefined(turnRetryMessageId)) &&
							canRetryMessage(turnRetryMessageId);
						return (
							<box
								key={turn.id}
								marginTop={item === transcriptTimeline[0] ? 1 : 0}
								width="100%"
							>
								<ChatMessage
									footerMessage={footerMessages.get(turn.id)}
									forkCheckpoints={forkCheckpoints}
									isRewindDisabled={
										isBusy || rewindingCheckpointId !== undefined
									}
									messages={turn.messages}
									notificationsAfterMessage={notificationsByMessageId}
									onRetry={canRetryTurn ? onRetry : undefined}
									onRewindCheckpoint={onRewindCheckpoint}
									rewindingCheckpointId={rewindingCheckpointId}
									showActions={showActions && !isBusy}
									streaming={isBusy && turn.id === turns.at(-1)?.id}
								/>
							</box>
						);
					})}
					{isCompacting ? (
						<CompactionStatus agent={agent} autoCompact={autoCompact} />
					) : null}
					{error && !isRepeatedTerminalError ? (
						<ErrorMessage error={error} />
					) : null}
				</box>
			</scrollbox>
			<box flexDirection="column" flexShrink={0} paddingBottom={1} width="100%">
				<WaitingMessageStrip queued={queuedSubmissions} />

				<box flexShrink={0} position="relative" width="100%">
					<ChatTextArea
						activityIndicator={
							isBusy ? (
								<ActivityFooter
									accentColor={activityAccentColor}
									agent={agent}
									autoCompact={autoCompact}
									isCompacting={isCompacting}
									retryOperation={retryOperation}
									retryStatus={retryStatus}
								/>
							) : undefined
						}
						composerBorderColor={composerBorderColor}
						draftKey={draftKey}
						id={composerId}
						isSelectionReady={isSelectionReady}
						onCompact={onCompact}
						onEmptySubmit={onEmptySubmit}
						onOpenSessionHistory={onOpenSessionHistory}
						onOpenSettings={onOpenSettings}
						onProviderModelChanged={onProviderModelChanged}
						onSubmit={handleSubmit}
						providerController={providerController}
						recalledSubmissions={recalledSubmissions}
						recallRevision={recallRevision}
						sessionId={viewId}
						sessionPromptHistory={promptHistory}
					/>
				</box>
				<SessionFooterStatuses scope={viewId} />
				<box
					flexDirection="row"
					flexShrink={0}
					justifyContent="space-between"
					paddingLeft={1}
					width="100%"
				>
					<WorkspacePath />
					{usage ? (
						<SessionUsageBar autoCompact={autoCompact} summary={usage} />
					) : null}
				</box>
			</box>
		</box>
	);
}

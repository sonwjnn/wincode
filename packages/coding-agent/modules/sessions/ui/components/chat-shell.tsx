import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { AgentId, SessionMessageId } from "@wincode/agent-core";
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
import type { SessionUsageEntry } from "@/modules/sessions/storage/session-store";
import {
	AUTO_COMPACT_SETTING,
	useSettingRegistryValue,
} from "@/modules/settings";
import {
	useKeyboardLayer,
	useToggleShortcut,
} from "@/shared/providers/keyboard-layer/keyboard-layer-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	getThinkingLevelBorderColor,
	getThinkingLevelColor,
} from "@/shared/providers/theme/themes";
import { Spinner } from "@/shared/ui/spinner";
import { useUiComponentFocus } from "@/shared/ui/ui-component-registry";
import type { SessionQueuedSubmission } from "../../agent-session/types";
import {
	isCompactionSummaryMessage,
	type SessionCompaction,
} from "../../compaction";
import type { PromptHistoryEntry } from "../../hooks/input-controller/history";
import type { SessionSubmissionComposition } from "../../submission-types";
import { summarizeSessionUsage } from "../../usage/session-usage";
import type { ChatPromptSubmission } from "../../utils";
import { ErrorMessage } from "../messages";
import { ChatMessage } from "./chat-message";
import { ChatTextArea } from "./chat-text-area";
import {
	buildSessionTimeline,
	type SessionTimelineItem,
} from "./chat-timeline";
import {
	groupMessagesBySessionTurn,
	resolveRetryMessageId,
	resolveSessionTurnFooterMessages,
} from "./chat-turns";
import { CompactionDivider } from "./compaction-divider";
import { CompactionStatus } from "./compaction-status";
import { SessionUsageBar } from "./session-usage-bar";
import { WaitingMessageStrip } from "./waiting-message-strip";
import { WorkspacePath } from "./workspace-path";

const EMPTY_QUEUED_SUBMISSIONS: readonly SessionQueuedSubmission[] = [];

type ChatShellProps = {
	activeMessages?: readonly SessionMessage[];
	compactions?: readonly SessionCompaction[];
	draftKey?: string;
	error?: unknown;
	isBusy: boolean;
	isSelectionReady?: boolean;
	isCompacting: boolean;
	messages: readonly SessionMessage[];
	onCompact?: (focus?: string) => Promise<boolean> | boolean;
	onProviderModelChanged?: () => void;
	onOpenSettings?: (section?: string) => Promise<void> | void;
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
	recalledSubmissions?: readonly SessionSubmissionComposition[];
	/** Changes whenever `recalledSubmissions` holds something new to restore. */
	recallRevision?: number;
	viewId: string;
	sessionUsageEntries?: readonly SessionUsageEntry[];
	cacheWarmingStatus?: CacheWarmingStatus;
	/** Rendered at the bottom of the transcript; the shell never persists it. */
	transcriptNotice?: ReactNode;
};
function ActivityFooter({
	accentColor,
	agent,
	autoCompact,
	isCompacting,
}: {
	accentColor: string;
	agent: AgentId;
	autoCompact: boolean;
	isCompacting: boolean;
}) {
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
const findNewestCompaction = (
	compactions: readonly SessionCompaction[]
): SessionCompaction | undefined => {
	let newest: SessionCompaction | undefined;
	for (const compaction of compactions) {
		if (isUndefined(newest) || compaction.sequence > newest.sequence) {
			newest = compaction;
		}
	}
	return newest;
};

const TRANSCRIPT_NOTICE = Symbol("transcript-notice");

type TranscriptEntry = SessionTimelineItem | typeof TRANSCRIPT_NOTICE;

/**
 * Slots the transient notice after every message that existed when it first
 * appeared, so messages arriving later read below it instead of pushing it
 * down. The notice is never persisted: a fresh mount captures the anchor again
 * and renders it at the end of the loaded transcript.
 */
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

export function ChatShell({
	activeMessages,
	compactions = [],
	draftKey,
	error,
	isBusy,
	isSelectionReady,
	isCompacting,
	messages,
	onCompact,
	onProviderModelChanged,
	onOpenSettings,
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
	transcriptNotice,
}: ChatShellProps) {
	const scrollboxRef = useRef<ScrollBoxRenderable>(null);
	const focusScopeId = `chat-shell-${viewId}`;
	const composerId = `${focusScopeId}-composer`;
	const transcriptId = `${focusScopeId}-transcript`;
	const backgroundComponentIds = useMemo(() => [transcriptId], [transcriptId]);
	const { isTopLayer } = useKeyboardLayer();
	const [scrollRequest, setScrollRequest] = useState(0);
	const { agent, model, thinkingLevel } = usePromptConfig();
	const { colors } = useTheme();
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
	const liveCompaction = findNewestCompaction(compactions);
	const historicalCompactions = compactions.filter(
		({ id }) => id !== liveCompaction?.id
	);
	const turns = groupMessagesBySessionTurn(displayMessages);
	const timeline = buildSessionTimeline(displayMessages, historicalCompactions);
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
	const noticeSlot = resolveNoticeSlot(timeline, noticeAnchorMessageCount);
	const transcriptEntries: readonly TranscriptEntry[] = hasTranscriptNotice
		? [
				...timeline.slice(0, noticeSlot),
				TRANSCRIPT_NOTICE,
				...timeline.slice(noticeSlot),
			]
		: timeline;
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
	const usage = useMemo(
		() =>
			summarizeSessionUsage(
				displayMessages,
				model,
				sessionUsageEntries,
				cacheWarmingStatus,
				providerModels
			),
		[
			displayMessages,
			model,
			sessionUsageEntries,
			cacheWarmingStatus,
			providerModels,
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
			!canRetry ||
			isUndefined(latestRetryMessageId) ||
			isUndefined(onRetry) ||
			!isTopLayer("base") ||
			!key.option ||
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
								<box key="transcript-notice" paddingX={3} width="100%">
									{transcriptNotice}
								</box>
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
								marginTop={item === timeline[0] ? 1 : 0}
								width="100%"
							>
								<ChatMessage
									footerMessage={footerMessages.get(turn.id)}
									messages={turn.messages}
									onRetry={canRetryTurn ? onRetry : undefined}
									streaming={isBusy && turn.id === turns.at(-1)?.id}
								/>
							</box>
						);
					})}
					{liveCompaction ? <CompactionDivider entry={liveCompaction} /> : null}
					{isCompacting ? (
						<CompactionStatus agent={agent} autoCompact={autoCompact} />
					) : null}
					{error ? <ErrorMessage error={error} /> : null}
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
								/>
							) : undefined
						}
						composerBorderColor={composerBorderColor}
						draftKey={draftKey}
						id={composerId}
						isSelectionReady={isSelectionReady}
						onCompact={onCompact}
						onEmptySubmit={onEmptySubmit}
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

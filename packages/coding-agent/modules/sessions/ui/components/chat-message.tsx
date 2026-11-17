import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { SessionMessageId, SessionRecordId } from "@wincode/agent-core";
import { isUndefined } from "@wincode/utils";
import { createElement, type ReactNode } from "react";
import { buildAgent } from "@/modules/agents";
import {
	PluginRendererErrorBoundary,
	useInteractivePluginRuntime,
	usePluginRendererRevision,
} from "@/modules/plugins/ui/plugin-renderer-boundary";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionForkCheckpointAssessment } from "@/modules/sessions/session-fork-checkpoint-validation";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import type {
	UiNotification,
	UiNotificationLevel,
} from "@/shared/providers/toast/types";
import {
	BotMessageContent,
	BotMessageFooter,
	ErrorMessage,
	getAppliedSkill,
	getAssistantFailureText,
	UserMessage,
} from "../messages";
import { resolveRetryMessageId } from "./chat-turns";
import { SessionWriterAction } from "./session-writer-controls";

function AssistantTranscriptContent({
	message,
	streaming,
}: {
	message: SessionMessage;
	streaming: boolean;
}) {
	const failureText = getAssistantFailureText(message);
	if (failureText === undefined) {
		return (
			<BotMessageContent
				agent={message.metadata?.agent ?? buildAgent.id}
				parts={message.parts}
				streaming={streaming}
			/>
		);
	}
	return (
		<>
			<ErrorMessage error={new Error(failureText)} />
			<BotMessageContent
				agent={message.metadata?.agent ?? buildAgent.id}
				parts={message.parts.filter((part) => part.type !== "text")}
			/>
		</>
	);
}

function DefaultSessionTranscriptMessage({
	message,
	streaming,
}: Readonly<{ message: SessionMessage; streaming: boolean }>) {
	if (message.role === "user") {
		return (
			<UserMessage
				appliedSkill={getAppliedSkill(message.metadata)}
				parts={message.parts}
				submissionFailure={message.metadata?.submissionFailure}
			/>
		);
	}
	return <AssistantTranscriptContent message={message} streaming={streaming} />;
}

function SessionTranscriptMessage({
	message,
	sessionId,
	streaming,
}: Readonly<{
	message: SessionMessage;
	sessionId?: string;
	streaming: boolean;
}>) {
	const runtime = useInteractivePluginRuntime();
	const rendererRevision = usePluginRendererRevision(runtime);
	const { currentTheme } = useTheme();
	const dimensions = useTerminalDimensions();
	const contribution =
		message.role === "tool"
			? undefined
			: runtime?.getMessageRenderer(message.role, sessionId);
	if (contribution === undefined) {
		return (
			<DefaultSessionTranscriptMessage
				message={message}
				streaming={streaming}
			/>
		);
	}
	const Renderer = contribution.component;
	const fallback = (
		<DefaultSessionTranscriptMessage message={message} streaming={streaming} />
	);
	return (
		<PluginRendererErrorBoundary
			fallback={fallback}
			key={`${contribution.pluginId}:${message.id}:${rendererRevision}`}
			pluginId={contribution.pluginId}
			surface="message"
		>
			{createElement(Renderer, {
				dimensions,
				message,
				options: { streaming },
				theme: currentTheme,
			})}
		</PluginRendererErrorBoundary>
	);
}

export function ChatMessage({
	footerMessage,
	forkCheckpoints,
	isRewindDisabled = false,
	messages,
	notificationsAfterMessage,
	rewindingCheckpointId,
	onRewindCheckpoint,
	onRetry,
	showActions = false,
	streaming = false,
	sessionId,
}: {
	footerMessage?: SessionMessage;
	forkCheckpoints?: ReadonlyMap<
		SessionMessageId,
		SessionForkCheckpointAssessment
	>;
	isRewindDisabled?: boolean;
	messages: SessionMessage[];
	notificationsAfterMessage?: ReadonlyMap<string, readonly UiNotification[]>;
	rewindingCheckpointId?: SessionRecordId;
	onRewindCheckpoint?: (recordId: SessionRecordId) => void | Promise<void>;
	onRetry?: (messageId: SessionMessageId) => void | Promise<void>;
	showActions?: boolean;
	streaming?: boolean;
	sessionId?: string;
}) {
	const { colors } = useTheme();
	const retryMessageId = resolveRetryMessageId(messages);
	const latestAssistant = messages.findLast(
		(message) => message.role === "assistant"
	);
	const handleRetry = () => {
		if (isUndefined(retryMessageId) || isUndefined(onRetry)) {
			return;
		}
		void onRetry(retryMessageId);
	};
	const rewindCheckpoint = (recordId: SessionRecordId): void => {
		if (
			onRewindCheckpoint === undefined ||
			isRewindDisabled ||
			rewindingCheckpointId !== undefined
		) {
			return;
		}
		void onRewindCheckpoint(recordId);
	};
	const renderCheckpoint = (
		checkpoint: SessionForkCheckpointAssessment | undefined,
		message: SessionMessage
	): ReactNode => {
		if (!showActions || checkpoint === undefined) {
			return null;
		}
		if (checkpoint.status === "invalid") {
			if (
				checkpoint.kind === "assistant" &&
				message.role === "assistant" &&
				message.metadata?.terminalOutcome === "failed"
			) {
				return null;
			}
			return (
				<text
					fg={colors.textMuted}
					id={`checkpoint-refusal-${checkpoint.recordId}`}
				>
					{`Cannot rewind here: ${checkpoint.reason ?? "This is not a valid checkpoint."}`}
				</text>
			);
		}
		if (onRewindCheckpoint === undefined) {
			return (
				<text
					fg={colors.textMuted}
					id={`checkpoint-refusal-${checkpoint.recordId}`}
				>
					Rewind is unavailable in this Session view.
				</text>
			);
		}
		const isRewinding = rewindingCheckpointId === checkpoint.recordId;
		return (
			<>
				<SessionWriterAction
					disabled={isRewindDisabled || isRewinding}
					id={`rewind-${checkpoint.recordId}`}
					label={
						isRewinding ? "Rewinding Session..." : "Rewind to this checkpoint"
					}
					onActivate={() => rewindCheckpoint(checkpoint.recordId)}
				/>
				<text fg={colors.textMuted}>
					Workspace files will not be rolled back.
				</text>
				{isRewindDisabled && !isRewinding ? (
					<text fg={colors.textMuted}>
						Rewind is unavailable while the Session is active or compacting.
					</text>
				) : null}
			</>
		);
	};

	return (
		<box alignItems="flex-start" flexDirection="column" width="100%">
			<box flexDirection="column" gap={1} width="100%">
				{messages.map((message) => (
					<box flexDirection="column" key={message.id} width="100%">
						<SessionTranscriptMessage
							message={message}
							sessionId={sessionId}
							streaming={streaming && message === latestAssistant}
						/>
						{renderCheckpoint(forkCheckpoints?.get(message.id), message)}
						{notificationsAfterMessage?.get(message.id)?.map((notification) => (
							<ChatNotificationMessage
								key={`session-notification-${notification.id}`}
								notification={notification}
							/>
						))}
					</box>
				))}
			</box>
			{showActions && retryMessageId && onRetry ? (
				<box paddingX={3} width="100%">
					{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes handle terminal mouse and keyboard events. */}
					<box
						focusable
						id={`retry-${retryMessageId}`}
						onKeyDown={(key) => {
							if (
								key.name !== "enter" &&
								key.name !== "return" &&
								key.name !== "space"
							) {
								return;
							}
							key.preventDefault();
							handleRetry();
						}}
						onMouseDown={handleRetry}
					>
						<text
							attributes={TextAttributes.BOLD}
							fg={colors.primary}
							selectable={false}
						>
							Retry
						</text>
					</box>
				</box>
			) : null}
			{footerMessage && messages.includes(footerMessage) ? (
				<box paddingTop={1} width="100%">
					<BotMessageFooter message={footerMessage} />
				</box>
			) : null}
		</box>
	);
}

const NOTIFICATION_PREFIX: Record<UiNotificationLevel, string> = {
	info: "",
	success: "",
	warning: "Warning: ",
	error: "Error: ",
};

export function ChatNotificationMessage({
	notification,
}: {
	notification: UiNotification;
}) {
	const { colors } = useTheme();
	const notificationColors: Record<UiNotificationLevel, string> = {
		info: colors.textMuted,
		success: colors.success,
		warning: colors.warning,
		error: colors.error,
	};
	return (
		<box paddingX={1} width="100%">
			<text
				fg={notificationColors[notification.level]}
				width="100%"
				wrapMode="word"
			>
				{`${NOTIFICATION_PREFIX[notification.level]}${notification.message}`}
			</text>
		</box>
	);
}

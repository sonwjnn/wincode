import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useModelPricing } from "@/modules/model-pricing";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useApprovalPanels } from "@/shared/providers/approval/approval-panels-provider";
import { ToolApprovalPanel } from "@/shared/providers/approval/ui/tool-approval-panel";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { getAgentColor } from "@/shared/providers/theme/themes";
import { Spinner } from "@/shared/ui/spinner";
import type { PromptHistoryEntry } from "../../hooks/input-controller/history";
import { summarizeSessionUsage } from "../../usage/session-usage";
import type { ChatPromptSubmission } from "../../utils";
import { ErrorMessage } from "../messages";
import { ChatMessage } from "./chat-message";
import { ChatTextArea } from "./chat-text-area";
import {
	groupMessagesByConversationTurn,
	resolveConversationTurnFooterMessages,
} from "./chat-turns";
import { SessionUsageBar } from "./session-usage-bar";

type ChatShellProps = {
	error?: unknown;
	isBusy: boolean;
	isInterruptArmed: boolean;
	messages: CodingAgentUIMessage[];
	promptHistory: PromptHistoryEntry[];
	onSubmit: (
		submission: ChatPromptSubmission
	) => boolean | Promise<boolean> | undefined;
};

export function ChatShell({
	error,
	isBusy,
	isInterruptArmed,
	messages,
	promptHistory,
	onSubmit,
}: ChatShellProps) {
	const scrollboxRef = useRef<ScrollBoxRenderable>(null);
	const [scrollRequest, setScrollRequest] = useState(0);
	const { agent, model } = usePromptConfig();
	const { colors } = useTheme();
	const agentColor = getAgentColor(colors, agent);
	const { table } = useModelPricing();
	const turns = groupMessagesByConversationTurn(messages);
	const footerMessages = resolveConversationTurnFooterMessages(turns);
	const usage = useMemo(
		() => summarizeSessionUsage(messages, model, table),
		[messages, model, table]
	);

	useEffect(() => {
		if (scrollRequest === 0) {
			return;
		}

		scrollboxRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
	}, [scrollRequest]);

	// Approvals without a pending tool call (explicit `/skill` activation before
	// the first model call) anchor to the composer instead of the timeline.
	const approvalEntries = useApprovalPanels().entries;
	const conversationApprovals = approvalEntries.filter(
		(entry) => entry.target === "conversation"
	);
	const pendingApprovalCount = approvalEntries.filter(
		(entry) => entry.resolution === undefined
	).length;

	// A new pending approval appears mid-turn (a tool call asked for approval
	// while the user scrolled up): bring it into view so the decision is never
	// missed. The sticky-bottom scrollbox already pins when at the bottom.
	const pendingApprovalCountRef = useRef(0);
	useEffect(() => {
		if (pendingApprovalCount > pendingApprovalCountRef.current) {
			scrollboxRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
		}
		pendingApprovalCountRef.current = pendingApprovalCount;
	}, [pendingApprovalCount]);

	const handleSubmit = (submission: ChatPromptSubmission) => {
		const accepted = onSubmit(submission);
		if (accepted === false) {
			return false;
		}
		setScrollRequest((request) => request + 1);
		return true;
	};

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			gap={1}
			height="100%"
			paddingBottom={1}
			paddingTop={0}
			paddingX={1}
			width="100%"
		>
			<scrollbox
				flexGrow={1}
				height="100%"
				ref={scrollboxRef}
				stickyScroll
				stickyStart="bottom"
				verticalScrollbarOptions={{ visible: false }}
			>
				<box flexDirection="column" gap={1}>
					{messages.length === 0 && !error ? (
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							No messages yet.
						</text>
					) : (
						turns.map((turn, index) => (
							<box key={turn.id} marginTop={index === 0 ? 1 : 0} width="100%">
								<ChatMessage
									footerMessage={footerMessages.get(turn.id)}
									messages={turn.messages}
								/>
							</box>
						))
					)}
					{error ? <ErrorMessage error={error} /> : null}
				</box>
			</scrollbox>
			<box flexShrink={0}>
				{conversationApprovals.map((entry) => (
					<ToolApprovalPanel id={entry.id} key={entry.id} />
				))}
				<ChatTextArea
					onSubmit={handleSubmit}
					sessionPromptHistory={promptHistory}
				/>
			</box>
			<box
				flexDirection="row"
				flexShrink={0}
				flexWrap="wrap"
				gap={2}
				justifyContent="space-between"
				paddingLeft={1}
				width="100%"
			>
				<box
					alignItems="center"
					flexDirection="row"
					flexGrow={1}
					flexShrink={1}
					gap={2}
				>
					{isBusy ? (
						<>
							<Spinner agent={agent} />
							<text>
								<span fg={agentColor}>Esc</span>
								<span fg={colors.textMuted}>
									{isInterruptArmed ? " again to interrupt" : " interrupt"}
								</span>
							</text>
						</>
					) : (
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							{process.cwd()}
						</text>
					)}
				</box>

				<box flexDirection="row" flexShrink={0} gap={2} marginLeft="auto">
					{usage ? <SessionUsageBar summary={usage} /> : null}
					<box flexDirection="row" flexShrink={0} gap={1}>
						<text fg={colors.text}>tab</text>
						<text attributes={TextAttributes.DIM} fg={colors.textMuted}>
							agents
						</text>
					</box>
				</box>
			</box>
		</box>
	);
}

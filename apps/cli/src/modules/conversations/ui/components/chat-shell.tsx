import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { useEffect, useRef, useState } from "react";
import { usePromptConfig } from "@/modules/prompt-settings/context/prompt-config-provider";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import { Spinner } from "@/shared/ui/spinner";
import type { PromptHistoryEntry } from "../../hooks/input-controller/history";
import { ErrorMessage } from "../messages";
import { ChatMessage } from "./chat-message";
import type { ChatPromptSubmission } from "./chat-text-area";
import { ChatTextArea } from "./chat-text-area";
import {
	groupMessagesByConversationTurn,
	resolveConversationTurnFooterMessages,
} from "./chat-turns";

type ChatShellProps = {
	error?: unknown;
	isBusy: boolean;
	isInterruptArmed: boolean;
	messages: CodingAgentUIMessage[];
	promptHistory: PromptHistoryEntry[];
	onSubmit: (submission: ChatPromptSubmission) => boolean | undefined;
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
	const { mode } = usePromptConfig();
	const { colors } = useTheme();
	const turns = groupMessagesByConversationTurn(messages);
	const footerMessages = resolveConversationTurnFooterMessages(turns);

	useEffect(() => {
		if (scrollRequest === 0) {
			return;
		}

		scrollboxRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
	}, [scrollRequest]);

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
			paddingX={2}
			paddingY={1}
			width="100%"
		>
			<scrollbox
				flexGrow={1}
				height="100%"
				ref={scrollboxRef}
				stickyScroll
				stickyStart="bottom"
			>
				<box flexDirection="column" gap={1}>
					{messages.length === 0 && !error ? (
						<text attributes={TextAttributes.DIM}>No messages yet.</text>
					) : (
						turns.map((turn) => (
							<ChatMessage
								footerMessage={footerMessages.get(turn.id)}
								key={turn.id}
								messages={turn.messages}
							/>
						))
					)}
					{error ? <ErrorMessage error={error} /> : null}
				</box>
			</scrollbox>

			<box flexShrink={0}>
				<ChatTextArea
					onSubmit={handleSubmit}
					sessionPromptHistory={promptHistory}
				/>
			</box>
			<box
				flexDirection="row"
				flexShrink={0}
				gap={2}
				height={1}
				justifyContent="space-between"
				paddingLeft={1}
				width="100%"
			>
				<box alignItems="center" flexDirection="row" gap={2}>
					{isBusy ? (
						<>
							<Spinner mode={mode} />
							<text>
								<span fg={colors.mode[mode]}>Esc</span>
								<span fg={colors.dimSeparator}>
									{isInterruptArmed ? " again to interrupt" : " interrupt"}
								</span>
							</text>
						</>
					) : null}
				</box>

				<box flexDirection="row" flexShrink={0} gap={1} marginLeft="auto">
					<text>tab</text>
					<text attributes={TextAttributes.DIM}>agents</text>
				</box>
			</box>
		</box>
	);
}

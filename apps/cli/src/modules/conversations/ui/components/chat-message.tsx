import { TextAttributes } from "@opentui/core";
import { buildAgent } from "@/modules/agents";
import type { ConversationMessage } from "@/modules/conversations/message";
import { useTheme } from "@/shared/providers/theme/theme-provider";
import {
	BotMessageContent,
	BotMessageFooter,
	getAppliedSkill,
	UserMessage,
} from "../messages";
import { resolveRetryMessageId } from "./chat-turns";

export function ChatMessage({
	footerMessage,
	messages,
	onRetry,
}: {
	footerMessage?: ConversationMessage;
	messages: ConversationMessage[];
	onRetry?: (messageId: string) => void | Promise<void>;
}) {
	const { colors } = useTheme();
	const retryMessageId = resolveRetryMessageId(messages);
	const handleRetry = () => {
		if (retryMessageId === undefined || onRetry === undefined) {
			return;
		}
		void onRetry(retryMessageId);
	};

	return (
		<box alignItems="flex-start" flexDirection="column" width="100%">
			<box flexDirection="column" gap={1} width="100%">
				{messages.map((message) => {
					if (message.role === "user") {
						return (
							<UserMessage
								agent={message.metadata?.agent ?? buildAgent.id}
								appliedSkill={getAppliedSkill(message.metadata)}
								key={message.id}
								parts={message.parts}
							/>
						);
					}

					return (
						<BotMessageContent
							agent={message.metadata?.agent ?? buildAgent.id}
							key={message.id}
							parts={message.parts}
						/>
					);
				})}
			</box>
			{retryMessageId && onRetry ? (
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

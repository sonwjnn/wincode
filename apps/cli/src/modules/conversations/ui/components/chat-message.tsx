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
					{/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text handles terminal mouse events. */}
					<text
						attributes={TextAttributes.BOLD}
						fg={colors.primary}
						onMouseDown={() => {
							void onRetry(retryMessageId);
						}}
					>
						Retry
					</text>
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

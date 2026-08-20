import { buildAgent, type CodingAgentUIMessage } from "@wincode/ai";
import {
	BotMessageContent,
	BotMessageFooter,
	getAppliedSkill,
	UserMessage,
} from "../messages";

export function ChatMessage({
	chatViewportHeight,
	footerMessage,
	isStreaming = false,
	messages,
}: {
	chatViewportHeight?: number;
	footerMessage?: CodingAgentUIMessage;
	/**
	 * True while the last assistant message can still grow; only the final
	 * message receives it so settled history keeps finalized parsing.
	 */
	isStreaming?: boolean;
	messages: CodingAgentUIMessage[];
}) {
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
							chatViewportHeight={chatViewportHeight}
							isStreaming={isStreaming && message === messages.at(-1)}
							key={message.id}
							parts={message.parts}
						/>
					);
				})}
			</box>
			{footerMessage && messages.includes(footerMessage) ? (
				<box paddingTop={1} width="100%">
					<BotMessageFooter message={footerMessage} />
				</box>
			) : null}
		</box>
	);
}

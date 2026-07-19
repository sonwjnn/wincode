import { type CodingAgentUIMessage, defaultMode } from "@wincode/ai";
import { BotMessageContent, BotMessageFooter, UserMessage } from "../messages";

export function ChatMessage({
	footerMessage,
	messages,
}: {
	footerMessage?: CodingAgentUIMessage;
	messages: CodingAgentUIMessage[];
}) {
	return (
		<box alignItems="flex-start" flexDirection="column" width="100%">
			<box flexDirection="column" gap={1} width="100%">
				{messages.map((message) => {
					if (message.role === "user") {
						return (
							<UserMessage
								key={message.id}
								mode={message.metadata?.mode ?? defaultMode.value}
								parts={message.parts}
							/>
						);
					}

					return <BotMessageContent key={message.id} parts={message.parts} />;
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

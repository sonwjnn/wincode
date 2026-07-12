import { type CodingAgentUIMessage, defaultMode } from "@wincode/ai";
import { BotMessageContent, BotMessageFooter, UserMessage } from "../messages";

type TextPart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "text" }
>;

const isTextPart = (
	part: CodingAgentUIMessage["parts"][number]
): part is TextPart => part.type === "text";

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
						const text = message.parts
							.filter(isTextPart)
							.map((part) => part.text)
							.join("");

						return (
							<UserMessage
								key={message.id}
								message={text}
								mode={message.metadata?.mode ?? defaultMode.value}
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

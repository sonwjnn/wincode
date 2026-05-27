import { TextAttributes } from "@opentui/core";
import type { CodingAgentUIMessage } from "@wincode/ai";
import {
	ChatReasoningPart,
	ChatTextPart,
	ChatToolPart,
	isToolPart,
} from "./message-parts";

const getMessageLabel = (message: CodingAgentUIMessage) => {
	if (message.role === "user") {
		return "You";
	}

	if (message.role === "assistant") {
		return "Assistant";
	}

	return message.role;
};

export function ChatMessage({ message }: { message: CodingAgentUIMessage }) {
	return (
		<box flexDirection="column">
			<text attributes={TextAttributes.BOLD}>{getMessageLabel(message)}:</text>
			{message.parts.map((part, index) => {
				const key = `${message.id}-${index}`;

				switch (part.type) {
					case "text":
						return <ChatTextPart key={key} part={part} />;
					case "reasoning":
						return <ChatReasoningPart key={key} part={part} />;
					case "step-start":
						return null;
					default:
						return isToolPart(part) ? (
							<ChatToolPart key={key} part={part} />
						) : null;
				}
			})}
		</box>
	);
}

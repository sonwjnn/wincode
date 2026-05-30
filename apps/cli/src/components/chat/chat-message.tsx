import type { CodingAgentUIMessage } from "@wincode/ai";
import { BotMessage, UserMessage } from "./messages";

type TextPart = Extract<
	CodingAgentUIMessage["parts"][number],
	{ type: "text" }
>;

const isTextPart = (
	part: CodingAgentUIMessage["parts"][number]
): part is TextPart => part.type === "text";

export function ChatMessage({ message }: { message: CodingAgentUIMessage }) {
	if (message.role === "user") {
		const text = message.parts
			.filter(isTextPart)
			.map((part) => part.text)
			.join("");

		return (
			<UserMessage message={text} mode={message.metadata?.mode ?? "build"} />
		);
	}

	return <BotMessage parts={message.parts} />;
}

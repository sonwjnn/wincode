import type { CodingAgentUIMessage } from "@wincode/ai";

export const shouldAutoStartAssistantTurn = (
	autoStart: boolean,
	initialPrompt: string,
	lastMessage: CodingAgentUIMessage | undefined
): boolean =>
	autoStart &&
	initialPrompt.trim().length === 0 &&
	lastMessage?.role === "user";

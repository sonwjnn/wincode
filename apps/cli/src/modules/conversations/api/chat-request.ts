import type {
	CodingAgentUIMessage,
	ModeType,
	SupportedChatModelId,
} from "@wincode/ai";

type SendChatRequestBody = {
	message: CodingAgentUIMessage;
	mode: ModeType;
	model: SupportedChatModelId;
	sendReasoning: true;
};

type ChatMetadataFallback = {
	mode: ModeType;
	model: SupportedChatModelId;
};

const findLastChatMetadata = (messages: CodingAgentUIMessage[]) =>
	messages.findLast(
		(message) => message.metadata?.mode && message.metadata.model
	)?.metadata;

export const prepareSendChatRequestBody = (
	_sessionId: string,
	messages: CodingAgentUIMessage[],
	fallback?: ChatMetadataFallback
): SendChatRequestBody => {
	const message = messages.at(-1);

	if (!message) {
		throw new Error("No message to send");
	}

	const metadata = findLastChatMetadata(messages);
	const mode = message.metadata?.mode ?? metadata?.mode ?? fallback?.mode;
	const model = message.metadata?.model ?? metadata?.model ?? fallback?.model;

	if (!(mode && model)) {
		throw new Error("No chat mode or model to send");
	}

	return {
		message,
		mode,
		model,
		sendReasoning: true,
	};
};

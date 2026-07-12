import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModeType,
} from "@wincode/ai";

type SendChatRequestBody = {
	messages: CodingAgentUIMessage[];
	mode: ModeType;
	model: string;
	persist: false;
	sendReasoning: true;
};

type ChatMetadataFallback = {
	mode: ModeType;
	model: ChatModelSelection;
};

const findLastChatMetadata = (messages: CodingAgentUIMessage[]) =>
	messages.findLast(
		(message) => message.metadata?.mode && message.metadata.model
	)?.metadata;

const normalizeSelection = (model: unknown): ChatModelSelection | null => {
	if (
		typeof model === "object" &&
		model &&
		"modelId" in model &&
		"providerId" in model
	) {
		return model as ChatModelSelection;
	}

	if (String(model) === "gemini-3.5-flash") {
		return { modelId: "gemini-2.5-flash", providerId: "wincode" };
	}

	if (model === "gpt-5.4-mini") {
		return { modelId: "gpt-5.4-mini", providerId: "wincode" };
	}

	return null;
};

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
	const model =
		normalizeSelection(message.metadata?.model) ??
		normalizeSelection(metadata?.model) ??
		fallback?.model;

	if (!(mode && model)) {
		throw new Error("No chat mode or model to send");
	}

	if (model.providerId !== "wincode") {
		throw new Error(`Connect ${model.providerId} with /connect`);
	}

	return {
		messages,
		mode,
		model: model.modelId,
		persist: false,
		sendReasoning: true,
	};
};

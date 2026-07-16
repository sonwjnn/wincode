import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
	ModeType,
} from "@wincode/ai";
import {
	chatModelSelectionSchema,
	codingMessageMetadataSchema,
	normalizeChatModelSelection,
} from "@wincode/ai";

type SendChatRequestBody = {
	messages: CodingAgentUIMessage[];
	mode: ModeType;
	model: string;
	persist: false;
	variant?: ModelVariant;
	sendReasoning: true;
};

type ChatMetadataFallback = {
	mode: ModeType;
	model: ChatModelSelection;
	variant?: ModelVariant;
};

const findLastChatMetadata = (messages: CodingAgentUIMessage[]) =>
	messages.findLast(
		(message) => codingMessageMetadataSchema.safeParse(message.metadata).success
	)?.metadata;

const normalizeSelection = (model: unknown): ChatModelSelection | null => {
	if (typeof model === "string") {
		return normalizeChatModelSelection(model);
	}

	if (typeof model === "object" && model) {
		const parsed = chatModelSelectionSchema.safeParse(model);
		return parsed.success ? parsed.data : null;
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
	const variant = metadata?.variant ?? fallback?.variant;

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
		variant,
		sendReasoning: true,
	};
};

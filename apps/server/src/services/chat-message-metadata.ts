import type {
	CodingAgentUIMessage,
	ModeType,
	SupportedChatModelId,
} from "@wincode/ai";

type ChatMessageMetadata = NonNullable<CodingAgentUIMessage["metadata"]>;

type SessionTitleMessage = {
	parts: unknown;
	role: string;
};

const UNTITLED_SESSION = "Untitled session";

export const resolvePersistedChatMessageMetadata = (
	metadata: CodingAgentUIMessage["metadata"] | undefined,
	fallbackMode: ModeType,
	fallbackModel: SupportedChatModelId
): ChatMessageMetadata => ({
	...(metadata ?? {}),
	mode: metadata?.mode ?? fallbackMode,
	model: metadata?.model ?? fallbackModel,
});

export const resolveLoadedChatMessageMetadata = (
	metadata: unknown,
	fallbackMode: ModeType
): Partial<ChatMessageMetadata> => {
	const metadataRecord =
		typeof metadata === "object" && metadata !== null
			? (metadata as Partial<ChatMessageMetadata>)
			: {};

	return {
		...metadataRecord,
		mode: metadataRecord.mode ?? fallbackMode,
	};
};

export const getSessionTitle = (messages: SessionTitleMessage[]) => {
	for (const message of messages) {
		if (message.role !== "user") {
			continue;
		}

		if (!Array.isArray(message.parts)) {
			continue;
		}

		for (const part of message.parts) {
			if (
				typeof part !== "object" ||
				part === null ||
				!("type" in part) ||
				part.type !== "text" ||
				!("text" in part) ||
				typeof part.text !== "string"
			) {
				continue;
			}

			const title = part.text.trim();
			if (title) {
				return title;
			}
		}
	}

	return UNTITLED_SESSION;
};

import type {
	CodingAgentUIMessage,
	ModeType,
	SupportedChatModelId,
} from "@wincode/ai";

type ChatMessageMetadata = NonNullable<CodingAgentUIMessage["metadata"]>;

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

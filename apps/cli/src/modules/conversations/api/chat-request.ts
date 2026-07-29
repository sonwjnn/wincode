import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
	ModeType,
	SkillContext,
} from "@wincode/ai";
import {
	chatModelSelectionSchema,
	codingMessageMetadataSchema,
	codingMessageSkillSchema,
	normalizeChatModelSelection,
} from "@wincode/ai";

type SendChatRequestBody = {
	messages: CodingAgentUIMessage[];
	mode: ModeType;
	model: string;
	persist: false;
	skill?: SkillContext;
	variant?: ModelVariant;
	sendReasoning: true;
};

type ChatMetadataFallback = {
	mode: ModeType;
	model: ChatModelSelection;
	variant?: ModelVariant;
	skill?: SkillContext;
};

const findLastChatMetadata = (messages: CodingAgentUIMessage[]) =>
	messages.findLast(
		(message) => codingMessageMetadataSchema.safeParse(message.metadata).success
	)?.metadata;

const findOriginatingUserSkill = (
	messages: CodingAgentUIMessage[]
): SkillContext | undefined => {
	const message = [...messages].reverse().find(({ role }) => role === "user");
	const parsed = codingMessageSkillSchema.safeParse(message?.metadata?.skill);

	return parsed.success
		? {
				name: parsed.data.name,
				arguments: parsed.data.arguments,
				instructions: parsed.data.instructions,
			}
		: undefined;
};

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
	const skill = findOriginatingUserSkill(messages);

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
		...((skill ?? fallback?.skill) ? { skill: skill ?? fallback?.skill } : {}),
		variant,
		sendReasoning: true,
	};
};

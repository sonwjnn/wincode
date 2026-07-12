import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	createAgentUIStreamResponse,
	createIdGenerator,
	type LanguageModel,
	type UIMessageStreamOnFinishCallback,
} from "ai";
import {
	type CodingAgentModelUIMessage,
	expandFileMentionPartsForModel,
	restoreOriginalFileMentionParts,
} from "../file-mentions";
import type { CodingAgentUIMessage } from "../message";
import type { SupportedChatModelId } from "../models";
import { defaultMode, type ModeType } from "../modes";
import { sanitizeInterruptedMessagesForModel } from "../sanitize-interrupted-messages";
import { createCodingAgent } from "./agent";
import { getProviderErrorMessage } from "./error-message";

type CreateCodingAgentStreamResponseOptions = {
	mode?: ModeType;
	model: LanguageModel;
	modelId: SupportedChatModelId;
	onFinish?: UIMessageStreamOnFinishCallback<CodingAgentUIMessage>;
	providerOptions?: ProviderOptions;
	sendReasoning?: boolean;
	uiMessages: CodingAgentUIMessage[];
};

export const createCodingAgentStreamResponse = ({
	mode = defaultMode.value,
	model,
	modelId,
	onFinish,
	providerOptions,
	sendReasoning = true,
	uiMessages,
}: CreateCodingAgentStreamResponseOptions) => {
	const modelMessages = expandFileMentionPartsForModel(
		sanitizeInterruptedMessagesForModel(uiMessages)
	);
	const handleFinish: UIMessageStreamOnFinishCallback<
		CodingAgentModelUIMessage
	> = async ({ messages, responseMessage, ...event }) => {
		const [restoredResponseMessage] = restoreOriginalFileMentionParts(
			[responseMessage],
			uiMessages
		);

		if (!restoredResponseMessage) {
			return;
		}

		await onFinish?.({
			...event,
			messages: restoreOriginalFileMentionParts(messages, uiMessages),
			responseMessage: restoredResponseMessage,
		});
	};

	return createAgentUIStreamResponse({
		agent: createCodingAgent({ model, providerOptions }),
		generateMessageId: createIdGenerator({
			prefix: "msg",
			size: 16,
		}),
		onFinish: handleFinish,
		onError: getProviderErrorMessage,
		options: { mode, model: modelId },
		originalMessages: modelMessages,
		sendReasoning,
		uiMessages: modelMessages,
	});
};

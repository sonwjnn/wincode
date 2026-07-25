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
import { type CodingAgentLifecycleCallbacks, createCodingAgent } from "./agent";
import { getProviderErrorMessage } from "./error-message";

type CreateCodingAgentStreamResponseOptions = {
	mode?: ModeType;
	model: LanguageModel;
	modelId: SupportedChatModelId;
	maxOutputTokens?: number;
	maxSteps?: number;
	abortSignal?: AbortSignal;
	onEnd?: CodingAgentLifecycleCallbacks["onEnd"];
	onStepEnd?: CodingAgentLifecycleCallbacks["onStepEnd"];
	onFinish?: UIMessageStreamOnFinishCallback<CodingAgentUIMessage>;
	providerOptions?: ProviderOptions;
	sendReasoning?: boolean;
	uiMessages: CodingAgentUIMessage[];
};

export const createCodingAgentStreamResponse = ({
	mode = defaultMode.value,
	model,
	modelId,
	maxOutputTokens,
	maxSteps,
	abortSignal,
	onEnd,
	onStepEnd,
	onFinish: onUiFinish,
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

		await onUiFinish?.({
			...event,
			messages: restoreOriginalFileMentionParts(messages, uiMessages),
			responseMessage: restoredResponseMessage,
		});
	};

	const agentUiFinishHandler =
		handleFinish as unknown as UIMessageStreamOnFinishCallback<CodingAgentUIMessage>;

	return createAgentUIStreamResponse({
		agent: createCodingAgent({
			lifecycleCallbacks: {
				onFinish: async (event) => {
					await onEnd?.(event);
				},
				onStepEnd,
			},
			model,
			maxOutputTokens,
			maxSteps,
			providerOptions,
		}),
		generateMessageId: createIdGenerator({
			prefix: "msg",
			size: 16,
		}),
		onFinish: agentUiFinishHandler as never,
		onError: getProviderErrorMessage,
		abortSignal,
		options: { mode, model: modelId },
		originalMessages: modelMessages,
		sendReasoning,
		uiMessages: modelMessages,
	});
};

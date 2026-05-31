import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	createAgentUIStreamResponse,
	createIdGenerator,
	type LanguageModel,
	type UIMessageStreamOnFinishCallback,
} from "ai";
import type { CodingAgentUIMessage } from "../message";
import type { SupportedChatModelId } from "../models";
import { defaultMode, type ModeType } from "../modes";
import { createCodingAgent } from "./agent";

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
}: CreateCodingAgentStreamResponseOptions) =>
	createAgentUIStreamResponse({
		agent: createCodingAgent({ model, providerOptions }),
		generateMessageId: createIdGenerator({
			prefix: "msg",
			size: 16,
		}),
		onFinish,
		options: { mode, model: modelId },
		originalMessages: uiMessages,
		sendReasoning,
		uiMessages,
	});

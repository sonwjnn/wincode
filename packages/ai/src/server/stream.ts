import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	createAgentUIStreamResponse,
	createIdGenerator,
	type LanguageModel,
	type UIMessageStreamOnFinishCallback,
} from "ai";
import type { ResolvedAgentRuntime } from "../agents";
import {
	type CodingAgentModelUIMessage,
	expandFileMentionPartsForModel,
	restoreOriginalFileMentionParts,
} from "../file-mentions";
import type { McpToolManifest } from "../mcp-tools";
import type { CodingAgentUIMessage } from "../message";
import type { SupportedChatModelId } from "../models";
import { sanitizeInterruptedMessagesForModel } from "../sanitize-interrupted-messages";
import {
	formatSkillUserContext,
	type SkillRequestContext,
	type SkillToolDefinition,
} from "../skill-context";
import { buildUsageMessageMetadata } from "../usage";
import { type CodingAgentLifecycleCallbacks, createCodingAgent } from "./agent";
import { getProviderErrorMessage } from "./error-message";

type CreateCodingAgentStreamResponseOptions = {
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
	skill?: SkillRequestContext;
	skillTool?: SkillToolDefinition;
	mcpTools?: McpToolManifest;
	resolvedAgent?: ResolvedAgentRuntime;
};

export const createCodingAgentStreamResponse = ({
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
	skill,
	skillTool,
	mcpTools = [],
	resolvedAgent,
}: CreateCodingAgentStreamResponseOptions) => {
	const modelMessages = expandFileMentionPartsForModel(
		sanitizeInterruptedMessagesForModel(uiMessages)
	);
	if (skill) {
		modelMessages.push({
			id: "skill-context",
			role: "user",
			parts: [{ type: "text", text: formatSkillUserContext(skill) }],
		});
	}
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
			skill,
			skillTool,
		}),
		generateMessageId: createIdGenerator({
			prefix: "msg",
			size: 16,
		}),
		messageMetadata: buildUsageMessageMetadata,
		onFinish: agentUiFinishHandler as never,
		onError: getProviderErrorMessage,
		abortSignal,
		options: { model: modelId, mcpTools, resolvedAgent },
		originalMessages: modelMessages,
		sendReasoning,
		uiMessages: modelMessages,
	});
};

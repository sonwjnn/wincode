import {
	buildUsageMessageMetadata,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	expandFileMentionPartsForModel,
	getChatModelRoute,
	type ModelVariant,
	type ModeType,
	sanitizeInterruptedMessagesForModel,
} from "@wincode/ai";
import {
	createCodingAgent,
	getProviderErrorMessage,
	resolveDirectChatModel,
	resolveOpenAIChatModel,
} from "@wincode/ai/server";
import { type ChatTransport, createAgentUIStream } from "ai";
import type { Connections } from "@/modules/connections";

type MutableRefObject<T> = { current: T };

type LocalChatTransport = ChatTransport<CodingAgentUIMessage>;
type CreateAgentUIStream = typeof createAgentUIStream;

export const createLocalChatTransport = (
	_sessionId: string,
	modeRef: MutableRefObject<ModeType>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	connections: Connections,
	createStream: CreateAgentUIStream = createAgentUIStream
): LocalChatTransport => ({
	sendMessages: async ({ abortSignal, messages }) => {
		const selection = modelRef.current;
		if (getChatModelRoute(selection) !== "direct") {
			throw new Error("Local transport requires a direct model");
		}

		const resolvedModel = await resolveResolvedModel(
			selection,
			connections,
			variantRef.current,
			abortSignal
		);
		const agent = createCodingAgent({
			model: resolvedModel.model,
			maxOutputTokens: resolvedModel.maxOutputTokens,
			providerOptions: resolvedModel.providerOptions,
		});

		const modelMessages = expandFileMentionPartsForModel(
			sanitizeInterruptedMessagesForModel(messages)
		);

		return createStream({
			agent,
			abortSignal,
			messageMetadata: buildUsageMessageMetadata,
			originalMessages: modelMessages,
			options: { mode: modeRef.current, model: resolvedModel.modelId },
			onError: getProviderErrorMessage,
			sendReasoning: true,
			uiMessages: modelMessages,
		});
	},
	reconnectToStream: async () => null,
});

async function resolveResolvedModel(
	selection: ChatModelSelection,
	connections: Connections,
	variant?: ModelVariant,
	signal?: AbortSignal
) {
	const authorization = await connections.authorize(
		selection.providerId,
		signal
	);
	if (authorization.kind === "api-key") {
		return resolveDirectChatModel(selection, authorization.apiKey, { variant });
	}

	// OpenAI OAuth is the only supported OAuth direct route.
	if (authorization.kind === "oauth" && selection.providerId === "openai") {
		return resolveOpenAIChatModel(
			selection.modelId,
			{
				accessToken: authorization.accessToken,
				accountId: authorization.accountId,
				originator: "wincode",
			},
			{ variant }
		);
	}

	throw new Error(
		"Local transport requires api-key or supported oauth authorization"
	);
}

import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	expandFileMentionPartsForModel,
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
import type {
	AuthorizationByProvider,
	Connections,
} from "@/modules/connections";

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
		if (selection.providerId === "wincode") {
			throw new Error(
				"Local transport only handles openai, anthropic, or google"
			);
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
	switch (selection.providerId) {
		case "openai":
			return resolveOpenAIAuthorization(
				selection,
				await connections.authorize("openai", signal),
				variant
			);
		case "anthropic":
			return resolveDirectChatModel(
				selection,
				(await connections.authorize("anthropic", signal)).apiKey,
				{ variant }
			);
		case "google":
			return resolveDirectChatModel(
				selection,
				(await connections.authorize("google", signal)).apiKey,
				{ variant }
			);
		default:
			throw new Error(
				"Local transport only handles openai, anthropic, or google"
			);
	}
}

async function resolveOpenAIAuthorization(
	selection: ChatModelSelection,
	authorization: AuthorizationByProvider["openai"],
	variant?: ModelVariant
) {
	if (authorization.kind === "api-key") {
		return resolveDirectChatModel(selection, authorization.apiKey, { variant });
	}

	if (authorization.kind === "oauth") {
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

	throw new Error("OpenAI auth must be api-key or oauth");
}

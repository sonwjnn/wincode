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
import type { McpCatalogSnapshot } from "@/modules/mcp";
import { getOriginatingUserSkill } from "../utils";

type MutableRefObject<T> = { current: T };

type CreateAgentUIStream = typeof createAgentUIStream;

export const createLocalChatTransport = (
	_sessionId: string,
	modeRef: MutableRefObject<ModeType>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	connections: Connections,
	createStream: CreateAgentUIStream = createAgentUIStream,
	snapshot?: McpCatalogSnapshot
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async ({ abortSignal, messages }) => {
		const selection = modelRef.current;
		const skill = getOriginatingUserSkill(messages);
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
			skill,
		});

		const modelMessages = expandFileMentionPartsForModel(
			sanitizeInterruptedMessagesForModel(messages)
		);

		return createStream({
			agent,
			abortSignal,
			messageMetadata: buildUsageMessageMetadata,
			originalMessages: modelMessages,
			options: {
				mode: modeRef.current,
				model: resolvedModel.modelId,
				...(snapshot?.manifest.length ? { mcpTools: snapshot.manifest } : {}),
			},
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

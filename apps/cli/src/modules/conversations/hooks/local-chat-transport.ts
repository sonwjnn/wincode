import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	expandFileMentionPartsForModel,
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
import {
	createConnectionsStore,
	type OpenAICredential,
	refreshOpenAICredential,
} from "@/modules/connections";

type MutableRefObject<T> = { current: T };

type LocalChatTransport = ChatTransport<CodingAgentUIMessage>;
type CreateAgentUIStream = typeof createAgentUIStream;

const sharedConnectionsStore = createConnectionsStore();

const assertApiKeyCredential = (
	providerId: "openai" | "anthropic",
	credential: unknown
): string => {
	if (
		!credential ||
		typeof credential !== "object" ||
		!("kind" in credential) ||
		credential.kind !== "api-key" ||
		!("apiKey" in credential) ||
		typeof credential.apiKey !== "string" ||
		credential.apiKey.length === 0
	) {
		throw new Error(`Connect ${providerId} with /connect`);
	}

	return credential.apiKey;
};

export const createLocalChatTransport = (
	_sessionId: string,
	modeRef: MutableRefObject<ModeType>,
	modelRef: MutableRefObject<ChatModelSelection>,
	connectionsStore = sharedConnectionsStore,
	createStream: CreateAgentUIStream = createAgentUIStream
): LocalChatTransport => ({
	sendMessages: async ({ abortSignal, messages }) => {
		const selection = modelRef.current;
		if (selection.providerId === "wincode") {
			throw new Error("Local transport only handles openai or anthropic");
		}

		const credential = await connectionsStore.load(selection.providerId);
		const resolvedModel = await resolveResolvedModel(
			selection,
			credential,
			connectionsStore
		);
		const agent = createCodingAgent({
			model: resolvedModel.model,
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
	credential: unknown,
	connectionsStore: ReturnType<typeof createConnectionsStore>
) {
	if (selection.providerId === "openai" && isOpenAICredential(credential)) {
		if (credential.kind === "api-key") {
			return resolveDirectChatModel(
				selection,
				assertApiKeyCredential("openai", credential)
			);
		}
		const openaiSession =
			credential.kind === "oauth-session" ? credential : null;
		if (openaiSession !== null) {
			if (!openaiSession.accountId) {
				throw new Error(
					"OpenAI account ID missing. Reconnect OpenAI with /connect."
				);
			}
			const refreshed = (await refreshOpenAICredential(
				connectionsStore,
				openaiSession
			)) as Extract<OpenAICredential, { kind: "oauth-session" }>;
			return resolveOpenAIChatModel(selection.modelId, {
				accessToken: refreshed.accessToken,
				accountId: refreshed.accountId,
				originator: "wincode",
			});
		}
	}

	const apiKey = assertApiKeyCredential(
		selection.providerId === "openai" ? "openai" : "anthropic",
		credential
	);
	return resolveDirectChatModel(selection, apiKey);
}

function isOpenAICredential(candidate: unknown): candidate is OpenAICredential {
	return (
		!!candidate &&
		typeof candidate === "object" &&
		"kind" in candidate &&
		(candidate.kind === "api-key" || candidate.kind === "oauth-session")
	);
}

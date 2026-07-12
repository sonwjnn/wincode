import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModeType,
} from "@wincode/ai";
import { normalizeChatModelSelection } from "@wincode/ai";
import { type ChatTransport, DefaultChatTransport } from "ai";
import { createConnectionsStore, getHostedBearer } from "@/modules/connections";
import { getHonoClient } from "@/shared/api/hono-client";
import { prepareSendChatRequestBody } from "../api/chat-request";
import { createLocalChatTransport } from "./local-chat-transport";

type MutableRefObject<T> = { current: T };

type RoutingChatTransport = ChatTransport<CodingAgentUIMessage>;

const sharedConnectionsStore = createConnectionsStore();

const getLatestSelection = (
	messages: CodingAgentUIMessage[],
	fallback: ChatModelSelection
): ChatModelSelection => {
	const latestMetadata = messages.findLast(
		(message) => message.metadata?.model
	)?.metadata;
	if (latestMetadata?.model !== undefined) {
		const normalizedLatestSelection = normalizeChatModelSelection(
			latestMetadata.model
		);
		if (!normalizedLatestSelection) {
			throw new Error(
				`Invalid chat model metadata: ${String(latestMetadata.model)}`
			);
		}

		return normalizedLatestSelection;
	}

	return fallback;
};

export const createRoutingChatTransport = (
	sessionId: string,
	modeRef: MutableRefObject<ModeType>,
	modelRef: MutableRefObject<ChatModelSelection>,
	connectionsStore = sharedConnectionsStore
): RoutingChatTransport => ({
	sendMessages: async ({ abortSignal, messages }) => {
		const selection = getLatestSelection(messages, modelRef.current);
		if (selection.providerId !== "wincode") {
			return createLocalChatTransport(sessionId, modeRef, {
				current: selection,
			}).sendMessages({
				abortSignal,
				body: undefined,
				chatId: sessionId,
				headers: undefined,
				messageId: undefined,
				messages,
				metadata: undefined,
				trigger: "submit-message",
			});
		}

		const authorization = await getHostedBearer(connectionsStore);
		const transport = new DefaultChatTransport<CodingAgentUIMessage>({
			api: getHonoClient()
				.api.sessions[":id"].chat.$url({ param: { id: sessionId } })
				.toString(),
			prepareSendMessagesRequest: ({ messages: requestMessages, api }) => ({
				api,
				body: prepareSendChatRequestBody(sessionId, requestMessages, {
					mode: modeRef.current,
					model: selection,
				}),
			}),
		});

		return transport.sendMessages({
			abortSignal,
			body: undefined,
			chatId: sessionId,
			headers: new Headers({ Authorization: `Bearer ${authorization}` }),
			messageId: undefined,
			metadata: undefined,
			messages,
			trigger: "submit-message",
		});
	},
	reconnectToStream: async ({ chatId }) => {
		const selection = normalizeChatModelSelection(modelRef.current);
		if (selection?.providerId !== "wincode") {
			return null;
		}

		const authorization = await getHostedBearer(connectionsStore);
		const transport = new DefaultChatTransport<CodingAgentUIMessage>({
			api: getHonoClient()
				.api.sessions[":id"].chat.$url({ param: { id: chatId } })
				.toString(),
			prepareReconnectToStreamRequest: ({ api, credentials }) => ({
				api,
				credentials,
			}),
		});

		return transport.reconnectToStream({
			chatId,
			headers: new Headers({ Authorization: `Bearer ${authorization}` }),
		});
	},
});

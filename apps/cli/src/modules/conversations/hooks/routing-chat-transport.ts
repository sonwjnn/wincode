import type {
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
	ModeType,
	ResolvedAgentRuntime,
} from "@wincode/ai";
import { getChatModelRoute, normalizeChatModelSelection } from "@wincode/ai";
import { type ChatTransport, DefaultChatTransport } from "ai";
import type { Connections } from "@/modules/connections";
import type { McpContextValue } from "@/modules/mcp";
import { getHonoClient } from "@/shared/api/hono-client";
import { prepareSendChatRequestBody } from "../api/chat-request";
import { getLatestChatConfig } from "../utils";
import { createLocalChatTransport } from "./local-chat-transport";

type MutableRefObject<T> = { current: T };

const getBearerToken = (
	authorization:
		| { kind: "api-key"; apiKey: string }
		| { kind: "bearer"; token: string }
) =>
	authorization.kind === "bearer" ? authorization.token : authorization.apiKey;

export const createRoutingChatTransport = (
	sessionId: string,
	modeRef: MutableRefObject<ModeType>,
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	connections: Connections,
	mcp: McpContextValue
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async ({ abortSignal, messages }) => {
		// One immutable snapshot per send so the request manifest and any dynamic
		// tool dispatch resolve against the same catalog.
		const snapshot = await mcp.createSnapshot(modeRef.current);
		const latestConfig = getLatestChatConfig(messages);
		const selection = latestConfig?.model ?? modelRef.current;
		const variant = latestConfig?.variant ?? variantRef.current;
		if (getChatModelRoute(selection) !== "hosted") {
			return createLocalChatTransport(
				sessionId,
				modeRef,
				resolvedAgentRef,
				{ current: selection },
				{ current: variant },
				connections,
				undefined,
				snapshot
			).sendMessages({
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

		const resolvedAgent = resolvedAgentRef.current;
		if (!resolvedAgent) {
			throw new Error("No resolved Agent to send");
		}
		const authorization = await connections.authorize("wincode", abortSignal);
		const transport = new DefaultChatTransport<CodingAgentUIMessage>({
			api: getHonoClient()
				.api.sessions[":id"].chat.$url({ param: { id: sessionId } })
				.toString(),
			prepareSendMessagesRequest: ({ messages: requestMessages, api }) => ({
				api,
				body: prepareSendChatRequestBody(
					sessionId,
					requestMessages,
					{
						agent: latestConfig?.agent ?? modeRef.current,
						mode: modeRef.current,
						model: selection,
						resolvedAgent,
						variant,
					},
					snapshot.manifest
				),
			}),
		});

		return transport.sendMessages({
			abortSignal,
			body: undefined,
			chatId: sessionId,
			headers: new Headers({
				Authorization: `Bearer ${getBearerToken(authorization)}`,
			}),
			messageId: undefined,
			metadata: undefined,
			messages,
			trigger: "submit-message",
		});
	},
	reconnectToStream: async ({ chatId }) => {
		const selection = normalizeChatModelSelection(modelRef.current);
		if (!selection || getChatModelRoute(selection) !== "hosted") {
			return null;
		}

		const authorization = await connections.authorize("wincode");
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
			headers: new Headers({
				Authorization: `Bearer ${getBearerToken(authorization)}`,
			}),
		});
	},
});

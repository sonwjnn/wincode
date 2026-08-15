import type {
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
	ResolvedAgentRuntime,
	SkillToolDefinition,
} from "@wincode/ai";
import { getChatModelRoute, normalizeChatModelSelection } from "@wincode/ai";
import { type ChatTransport, DefaultChatTransport } from "ai";
import type { Connections } from "@/modules/connections";
import type { McpContextValue } from "@/modules/mcp";
import { getHonoClient } from "@/shared/api/hono-client";
import { prepareSendChatRequestBody } from "../api/chat-request";
import { resolveConversationSelection } from "../selection";
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
	agentRef: MutableRefObject<AgentId>,
	resolvedAgentRef: MutableRefObject<ResolvedAgentRuntime | undefined>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	connections: Connections,
	mcp: McpContextValue,
	skillToolRef?: MutableRefObject<SkillToolDefinition | undefined>
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async ({ abortSignal, messages }) => {
		// One immutable snapshot per send so the request manifest and any dynamic
		// tool dispatch resolve against the same catalog.
		const snapshot = await mcp.createSnapshot(agentRef.current);
		const selection = resolveConversationSelection({
			messages,
			refs: {
				agent: agentRef.current,
				model: modelRef.current,
				variant: variantRef.current,
			},
		});
		if (!selection?.agent) {
			throw new Error("No resolved Agent or model to send");
		}
		const agent = selection.agent;
		if (getChatModelRoute(selection.model) !== "hosted") {
			return createLocalChatTransport(
				sessionId,
				resolvedAgentRef,
				{ current: selection.model },
				{ current: selection.variant },
				connections,
				undefined,
				snapshot,
				skillToolRef
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
						agent,
						model: selection.model,
						resolvedAgent,
						variant: selection.variant,
					},
					snapshot.manifest,
					skillToolRef?.current
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

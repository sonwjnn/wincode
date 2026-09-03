import type {
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
} from "@wincode/ai";
import type { SkillToolDefinition } from "@wincode/skills";
import type { ChatTransport } from "ai";
import type { AgentRegistry } from "@/modules/agents";
import { prepareAgentCall } from "@/modules/agents";
import type { Connections } from "@/modules/connections";
import type { McpContextValue } from "@/modules/mcp";
import type { AttachmentHydrationOptions } from "../storage/attachment-store";
import { getConversationStore } from "../storage/get-conversation-store";
import { createLocalChatTransport } from "./local-chat-transport";

type MutableRefObject<T> = { current: T };
type AttachmentModelBudget = Pick<
	AttachmentHydrationOptions,
	"maxAttachments" | "maxBytes" | "maxTokens"
>;

export const createRoutingChatTransport = (
	sessionId: string,
	agentRef: MutableRefObject<AgentId>,
	modelRef: MutableRefObject<ChatModelSelection>,
	variantRef: MutableRefObject<ModelVariant | undefined>,
	registry: AgentRegistry | null,
	connections: Connections,
	mcp: McpContextValue,
	skillToolRef?: MutableRefObject<SkillToolDefinition | undefined>,
	attachmentBudgetRef?: MutableRefObject<AttachmentModelBudget | undefined>
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async (options) => {
		const snapshot = await mcp.createSnapshot(agentRef.current);
		const prepared = prepareAgentCall(registry, {
			agent: agentRef.current,
			model: modelRef.current,
			variant: variantRef.current,
		});
		const messages = await getConversationStore().hydrateAttachments(
			options.messages,
			{
				purpose: "model",
				priorityMessageId: options.messages.findLast(
					({ role }) => role === "user"
				)?.id,
				signal: options.abortSignal,
				...(attachmentBudgetRef?.current ?? {}),
			}
		);
		return createLocalChatTransport(
			sessionId,
			{ current: prepared.resolvedAgent },
			modelRef,
			variantRef,
			connections,
			undefined,
			snapshot,
			skillToolRef,
			agentRef.current
		).sendMessages({ ...options, messages });
	},
	reconnectToStream: async () => null,
});

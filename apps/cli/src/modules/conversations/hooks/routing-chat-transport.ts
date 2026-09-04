import type { ConversationRecord } from "@wincode/agent-core";
import type {
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
} from "@wincode/ai";
import type { SkillExecution, SkillToolDefinition } from "@wincode/skills";
import type { ChatTransport } from "ai";
import type { MutableRefObject } from "react";
import type { AgentRegistry } from "@/modules/agents";
import { prepareAgentCall } from "@/modules/agents";
import type { Connections } from "@/modules/connections";
import type { McpContextValue } from "@/modules/mcp";
import type { ConversationViewState } from "../conversation-controller";
import type { AttachmentHydrationOptions } from "../storage/attachment-store";
import { getConversationStore } from "../storage/get-conversation-store";
import {
	createLocalChatTransport,
	delegationFromBody,
} from "./local-chat-transport";
import type { RuntimeGatedTooling } from "./runtime-turn";

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
	attachmentBudgetRef?: MutableRefObject<AttachmentModelBudget | undefined>,
	outcomeSignalRef?: MutableRefObject<AbortSignal | undefined>,
	gatedToolingRef?: MutableRefObject<RuntimeGatedTooling | undefined>,
	skillExecutionRef?: MutableRefObject<SkillExecution | null>,
	onViewState?: (state: ConversationViewState) => void
): ChatTransport<CodingAgentUIMessage> => ({
	sendMessages: async (options) => {
		const delegation = delegationFromBody(options.body);
		const snapshot = await mcp.createSnapshot(agentRef.current);
		const prepared = prepareAgentCall(
			registry,
			{
				agent: agentRef.current,
				model: modelRef.current,
				variant: variantRef.current,
			},
			{ allowSubagent: delegation !== undefined }
		);
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
			agentRef.current,
			undefined,
			(record: ConversationRecord) =>
				getConversationStore().commitConversationRecord({
					record,
					sessionId,
				}),
			outcomeSignalRef,
			gatedToolingRef?.current,
			skillExecutionRef,
			onViewState
		).sendMessages({ ...options, messages });
	},
	reconnectToStream: async () => null,
});

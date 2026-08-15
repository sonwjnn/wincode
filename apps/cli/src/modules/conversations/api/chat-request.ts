import type {
	AgentBillingKind,
	AgentId,
	CodingAgentUIMessage,
	HostedAgentDescriptor,
	McpToolManifest,
	ModelVariant,
	ResolvedAgentRuntime,
	SkillRequestContext,
	SkillToolDefinition,
} from "@wincode/ai";
import type { SelectionFallback } from "../selection";
import { resolveOutgoingSelection } from "../selection";

type SendChatRequestBody = {
	agent: HostedAgentDescriptor;
	messages: CodingAgentUIMessage[];
	model: string;
	persist: false;
	skill?: SkillRequestContext;
	skillTool?: SkillToolDefinition;
	variant?: ModelVariant;
	sendReasoning: true;
};

type ChatMetadataFallback = SelectionFallback & {
	resolvedAgent: ResolvedAgentRuntime;
};

const getBillingKind = (agent: AgentId): AgentBillingKind => {
	if (agent === "build" || agent === "plan") {
		return agent;
	}
	return "custom";
};

const removePrivateAgentMetadata = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage[] =>
	messages.map((message) => {
		if (!message.metadata?.agent) {
			return message;
		}
		const { agent: _agent, ...metadata } = message.metadata;
		return { ...message, metadata };
	});

export const prepareSendChatRequestBody = (
	_sessionId: string,
	messages: CodingAgentUIMessage[],
	fallback?: ChatMetadataFallback,
	mcpTools?: McpToolManifest,
	skillTool?: SkillToolDefinition
): SendChatRequestBody => {
	const selection = resolveOutgoingSelection(messages, fallback);

	if (!(selection.agent && selection.model && fallback?.resolvedAgent)) {
		throw new Error("No resolved Agent or model to send");
	}

	if (selection.model.providerId !== "wincode") {
		throw new Error(`Connect ${selection.model.providerId} with /connect`);
	}

	// The hosted runtime never executes shell (ADR-0005), so the CLI-only tool
	// is stripped from the descriptor; the server rejects it defensively too.
	const hostedVisibleCodingTools =
		fallback.resolvedAgent.visibleCodingTools.filter(
			(tool) => tool !== "shell"
		);

	return {
		agent: {
			billingKind: getBillingKind(selection.agent),
			instructions: fallback.resolvedAgent.instructions,
			mcpTools: mcpTools ?? [],
			visibleCodingTools: hostedVisibleCodingTools,
		},
		messages: removePrivateAgentMetadata(messages),
		model: selection.model.modelId,
		persist: false,
		...(selection.skill ? { skill: selection.skill } : {}),
		...(skillTool ? { skillTool } : {}),
		variant: selection.variant,
		sendReasoning: true,
	};
};

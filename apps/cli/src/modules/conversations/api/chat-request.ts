import type {
	CodingAgentUIMessage,
	HostedAgentDescriptor,
	ModelVariant,
	SkillRequestContext,
	SkillToolDefinition,
} from "@wincode/ai";
import type { PreparedAgentCall } from "@/modules/agents";
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

/**
 * Packs the hosted request body over a prepared Agent call. The uniform
 * hosted descriptor (ADR-0003) is projected by the Agent call-preparation
 * seam; this function only merges the outgoing message selection and strips
 * private metadata from the wire.
 */
export const prepareSendChatRequestBody = (
	_sessionId: string,
	messages: CodingAgentUIMessage[],
	prepared: PreparedAgentCall,
	skillTool?: SkillToolDefinition
): SendChatRequestBody => {
	const selection = resolveOutgoingSelection(messages, prepared);

	if (!(selection.agent && selection.model)) {
		throw new Error("No resolved Agent or model to send");
	}

	if (selection.model.providerId !== "wincode") {
		throw new Error(`Connect ${selection.model.providerId} with /connect`);
	}

	if (prepared.hostedDescriptor === undefined) {
		throw new Error("No hosted descriptor for this Agent call");
	}

	return {
		agent: prepared.hostedDescriptor,
		messages: removePrivateAgentMetadata(messages),
		model: selection.model.modelId,
		persist: false,
		...(selection.skill ? { skill: selection.skill } : {}),
		...(skillTool ? { skillTool } : {}),
		variant: selection.variant,
		sendReasoning: true,
	};
};

import type {
	AgentBillingKind,
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	HostedAgentDescriptor,
	McpToolManifest,
	ModelVariant,
	ModeType,
	ResolvedAgentRuntime,
	SkillContext,
} from "@wincode/ai";
import {
	chatModelSelectionSchema,
	codingMessageMetadataSchema,
	codingMessageSkillSchema,
	normalizeChatModelSelection,
} from "@wincode/ai";

type SendChatRequestBody = {
	agent: HostedAgentDescriptor;
	messages: CodingAgentUIMessage[];
	model: string;
	persist: false;
	skill?: SkillContext;
	variant?: ModelVariant;
	sendReasoning: true;
};

type ChatMetadataFallback = {
	agent: AgentId;
	mode: ModeType;
	model: ChatModelSelection;
	resolvedAgent: ResolvedAgentRuntime;
	variant?: ModelVariant;
	skill?: SkillContext;
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

const findLastChatMetadata = (messages: CodingAgentUIMessage[]) =>
	messages.findLast(
		(message) => codingMessageMetadataSchema.safeParse(message.metadata).success
	)?.metadata;

const findOriginatingUserSkill = (
	messages: CodingAgentUIMessage[]
): SkillContext | undefined => {
	const message = [...messages].reverse().find(({ role }) => role === "user");
	const parsed = codingMessageSkillSchema.safeParse(message?.metadata?.skill);

	return parsed.success
		? {
				name: parsed.data.name,
				arguments: parsed.data.arguments,
				instructions: parsed.data.instructions,
			}
		: undefined;
};

const normalizeSelection = (model: unknown): ChatModelSelection | null => {
	if (typeof model === "string") {
		return normalizeChatModelSelection(model);
	}

	if (typeof model === "object" && model) {
		const parsed = chatModelSelectionSchema.safeParse(model);
		return parsed.success ? parsed.data : null;
	}

	return null;
};

export const prepareSendChatRequestBody = (
	_sessionId: string,
	messages: CodingAgentUIMessage[],
	fallback?: ChatMetadataFallback,
	mcpTools?: McpToolManifest
): SendChatRequestBody => {
	const message = messages.at(-1);

	if (!message) {
		throw new Error("No message to send");
	}

	const metadata = findLastChatMetadata(messages);
	const agent = message.metadata?.agent ?? metadata?.agent ?? fallback?.agent;
	const mode = message.metadata?.mode ?? metadata?.mode ?? fallback?.mode;
	const model =
		normalizeSelection(message.metadata?.model) ??
		normalizeSelection(metadata?.model) ??
		fallback?.model;
	const variant = metadata?.variant ?? fallback?.variant;
	const skill = findOriginatingUserSkill(messages);

	if (!(agent && mode && model && fallback?.resolvedAgent)) {
		throw new Error("No resolved Agent or model to send");
	}

	if (model.providerId !== "wincode") {
		throw new Error(`Connect ${model.providerId} with /connect`);
	}

	return {
		agent: {
			billingKind: getBillingKind(agent),
			instructions: fallback.resolvedAgent.instructions,
			mcpTools: mcpTools ?? [],
			visibleCodingTools: fallback.resolvedAgent.visibleCodingTools,
		},
		messages: removePrivateAgentMetadata(messages),
		model: model.modelId,
		persist: false,
		...((skill ?? fallback?.skill) ? { skill: skill ?? fallback?.skill } : {}),
		variant,
		sendReasoning: true,
	};
};

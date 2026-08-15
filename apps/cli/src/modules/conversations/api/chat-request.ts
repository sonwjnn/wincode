import type {
	AgentBillingKind,
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	HostedAgentDescriptor,
	McpToolManifest,
	ModelVariant,
	ResolvedAgentRuntime,
	SkillRequestContext,
	SkillToolDefinition,
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
	skill?: SkillRequestContext;
	skillTool?: SkillToolDefinition;
	variant?: ModelVariant;
	sendReasoning: true;
};

type ChatMetadataFallback = {
	agent: AgentId;
	model: ChatModelSelection;
	resolvedAgent: ResolvedAgentRuntime;
	variant?: ModelVariant;
	skill?: SkillRequestContext;
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
): SkillRequestContext | undefined => {
	const message = [...messages].reverse().find(({ role }) => role === "user");
	const parsed = codingMessageSkillSchema.safeParse(message?.metadata?.skill);
	if (!parsed.success) {
		return;
	}
	const skill = parsed.data;
	if (!("instructions" in skill)) {
		return;
	}
	return {
		arguments: skill.arguments,
		contentHash: skill.contentHash,
		instructions: skill.instructions,
		name: skill.name,
		source: skill.source ?? "explicit",
	};
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
	mcpTools?: McpToolManifest,
	skillTool?: SkillToolDefinition
): SendChatRequestBody => {
	const message = messages.at(-1);

	if (!message) {
		throw new Error("No message to send");
	}

	const metadata = findLastChatMetadata(messages);
	const agent = message.metadata?.agent ?? metadata?.agent ?? fallback?.agent;
	const model =
		normalizeSelection(message.metadata?.model) ??
		normalizeSelection(metadata?.model) ??
		fallback?.model;
	const variant = metadata?.variant ?? fallback?.variant;
	const skill = findOriginatingUserSkill(messages);

	if (!(agent && model && fallback?.resolvedAgent)) {
		throw new Error("No resolved Agent or model to send");
	}

	if (model.providerId !== "wincode") {
		throw new Error(`Connect ${model.providerId} with /connect`);
	}

	// The hosted runtime never executes shell (ADR-0005), so the CLI-only tool
	// is stripped from the descriptor; the server rejects it defensively too.
	const hostedVisibleCodingTools =
		fallback.resolvedAgent.visibleCodingTools.filter(
			(tool) => tool !== "shell"
		);

	return {
		agent: {
			billingKind: getBillingKind(agent),
			instructions: fallback.resolvedAgent.instructions,
			mcpTools: mcpTools ?? [],
			visibleCodingTools: hostedVisibleCodingTools,
		},
		messages: removePrivateAgentMetadata(messages),
		model: model.modelId,
		persist: false,
		...((skill ?? fallback?.skill) ? { skill: skill ?? fallback?.skill } : {}),
		...(skillTool ? { skillTool } : {}),
		variant,
		sendReasoning: true,
	};
};

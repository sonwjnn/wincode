import {
	type AgentId,
	type ChatModelSelection,
	type CodingAgentUIMessage,
	chatModelSelectionSchema,
	codingMessageMetadataSchema,
	codingMessageSkillSchema,
	type ModelVariant,
	normalizeChatModelSelection,
	normalizeModelVariant,
	type SkillRequestContext,
} from "@wincode/ai";

/**
 * The conversation-selection module owns every read of message metadata:
 * the last-used selection, the originating Skill, and the precedence chain
 * that resolves what a new turn or an opened session actually uses.
 *
 * Two policies intentionally coexist here:
 * - restore reads leniently — a selection survives partially broken metadata;
 * - the request body reads strictly — only schema-valid pairs reach the send.
 */

export type LastUsedSelection = {
	agent: AgentId;
	model: ChatModelSelection;
	variant?: ModelVariant;
};

/**
 * The last selection actually used in a conversation: agent and model come
 * from the newest message that carries both; the variant scans back to the
 * last message that used one with that model, because a user message
 * submitted without re-picking a variant drops it at the JSON round trip.
 */
export const getLastUsedSelection = (
	messages: CodingAgentUIMessage[]
): LastUsedSelection | undefined => {
	let selection: { agent: AgentId; model: ChatModelSelection } | undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const metadata = messages[index]?.metadata;
		if (!metadata?.model) {
			continue;
		}

		const agent = metadata.agent;
		if (!agent) {
			continue;
		}

		const model = normalizeChatModelSelection(metadata.model);
		if (!model) {
			continue;
		}

		selection = { agent, model };
		break;
	}

	if (!selection) {
		return;
	}

	const variant = findLastUsedVariant(messages, selection.model);
	return variant === undefined ? selection : { ...selection, variant };
};

/**
 * The last variant actually used with `model`: scans back because a user
 * message submitted without re-picking a variant drops the key at the JSON
 * round trip, while its preceding assistant turn still carries it. Variants
 * are normalized against the resolved model so an unsupported pair never
 * restores.
 */
const findLastUsedVariant = (
	messages: CodingAgentUIMessage[],
	model: ChatModelSelection
): ModelVariant | undefined => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const metadata = messages[index]?.metadata;
		if (!metadata?.model) {
			continue;
		}
		const metadataModel = normalizeChatModelSelection(metadata.model);
		if (
			!metadataModel ||
			metadataModel.modelId !== model.modelId ||
			metadataModel.providerId !== model.providerId
		) {
			continue;
		}
		const variant = normalizeModelVariant(model, metadata.variant);
		if (variant !== undefined) {
			return variant;
		}
	}
	return;
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

/**
 * The newest message metadata that passes the full coding-message schema —
 * the strict read used for the request body, so an unsupported pair never
 * reaches the send.
 */
const findLastValidMetadata = (
	messages: CodingAgentUIMessage[]
): CodingAgentUIMessage["metadata"] | undefined =>
	messages.findLast(
		(message) => codingMessageMetadataSchema.safeParse(message.metadata).success
	)?.metadata;

/**
 * Resolves the Skill payload the current user turn carries for the model loop.
 * Only snapshots that still hold the body (in-memory or legacy persisted
 * records) resolve; sanitized activation metadata without instructions means
 * the Skill no longer applies and returns `undefined`.
 */
export const getOriginatingUserSkill = (
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

export type ResolvedConversationSelection = {
	agent: AgentId | undefined;
	persistedAgent: AgentId | undefined;
	model: ChatModelSelection;
	variant: ModelVariant | undefined;
};

export type ConversationSelectionRefs = {
	agent?: AgentId;
	model?: ChatModelSelection;
	variant?: ModelVariant;
};

type ResolveConversationSelectionInput = {
	messages: CodingAgentUIMessage[];
	resolveAgent?: (agentId: AgentId | undefined) => AgentId;
	sessionModel?: ChatModelSelection;
	sessionVariant?: ModelVariant;
	refs?: ConversationSelectionRefs;
};

/**
 * Resolves the selection a conversation uses, merging sources in a fixed
 * order — session row, then message metadata, then prompt-config refs —
 * for each field. Agent has no session-row source, so it merges messages
 * then refs, and passes through `resolveAgent` when the caller wants it
 * resolved against an Agent registry. The session-row variant is null for
 * sessions created before variant support or when the variant came from an
 * Agent pin, so the metadata scan-back keeps the last-used variant. The
 * resolved variant is normalized against the resolved model. Returns null
 * when no source carries a model.
 */
export const resolveConversationSelection = ({
	messages,
	resolveAgent,
	sessionModel,
	sessionVariant,
	refs,
}: ResolveConversationSelectionInput): ResolvedConversationSelection | null => {
	const persisted = getLastUsedSelection(messages);
	const model = sessionModel ?? persisted?.model ?? refs?.model;
	if (!model) {
		return null;
	}
	const persistedAgent = persisted?.agent ?? refs?.agent;
	const agent =
		resolveAgent && persistedAgent !== undefined
			? resolveAgent(persistedAgent)
			: persistedAgent;
	return {
		agent,
		persistedAgent,
		model,
		variant: normalizeModelVariant(
			model,
			sessionVariant ?? persisted?.variant ?? refs?.variant
		),
	};
};

/**
 * Restores the prompt config used by the newest message. Session-row values
 * remain a fallback for legacy conversations without usable message metadata.
 * This policy is intentionally narrower than resolveConversationSelection:
 * Home uses it for the next-chat default, while active conversations retain
 * the session-row choice/effective-message two-tier policy.
 */
export const resolveLastUsedConversationSelection = ({
	messages,
	resolveAgent,
	sessionModel,
	sessionVariant,
	refs,
}: ResolveConversationSelectionInput): ResolvedConversationSelection | null => {
	const persisted = getLastUsedSelection(messages);
	if (!persisted) {
		return resolveConversationSelection({
			messages,
			resolveAgent,
			sessionModel,
			sessionVariant,
			refs,
		});
	}

	return {
		agent: resolveAgent ? resolveAgent(persisted.agent) : persisted.agent,
		persistedAgent: persisted.agent,
		model: persisted.model,
		variant: normalizeModelVariant(persisted.model, persisted.variant),
	};
};

export type SelectionFallback = {
	agent: AgentId;
	model: ChatModelSelection;
	variant?: ModelVariant;
	skill?: SkillRequestContext;
};

export type OutgoingChatSelection = {
	agent: AgentId | undefined;
	model: ChatModelSelection | undefined;
	variant: ModelVariant | undefined;
	skill: SkillRequestContext | undefined;
};

/**
 * The selection a new turn sends: the last message's own metadata wins,
 * then the newest schema-valid metadata, then the transport fallback.
 * The Skill falls back to the transport-provided snapshot the same way.
 */
export const resolveOutgoingSelection = (
	messages: CodingAgentUIMessage[],
	fallback?: SelectionFallback
): OutgoingChatSelection => {
	const message = messages.at(-1);
	if (!message) {
		throw new Error("No message to send");
	}

	const metadata = findLastValidMetadata(messages);
	return {
		agent: message.metadata?.agent ?? metadata?.agent ?? fallback?.agent,
		model:
			normalizeSelection(message.metadata?.model) ??
			normalizeSelection(metadata?.model) ??
			fallback?.model,
		variant: metadata?.variant ?? fallback?.variant,
		skill: getOriginatingUserSkill(messages) ?? fallback?.skill,
	};
};

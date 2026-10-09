import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	modelSelectionSchema,
	normalizeChatModelSelection,
	normalizeThinkingSelection,
	type ThinkingLevel,
	type ThinkingSelection,
} from "@wincode/ai/models";
import { isPlainObject, isString, isUndefined } from "@wincode/utils";
import type { SkillRequestContext } from "@/modules/skills";
import type { SessionMessage } from "./message";
import {
	sessionMessageMetadataSchema,
	sessionMessageSkillSchema,
} from "./message";

/**
 * The session-selection module owns every read of message metadata:
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
	thinkingLevel?: ThinkingLevel;
};

/**
 * The last selection actually used in a session: agent and model come
 * from the newest message that carries both; the Thinking level scans back
 * to the last choice used with that model, because a user message submitted
 * without re-picking a choice drops that key at the JSON round trip.
 */
export const getLastUsedSelection = (
	messages: SessionMessage[]
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

	const thinking = findLastUsedThinkingSelection(messages, selection.model);
	return { ...selection, ...thinking };
};

/**
 * The last Thinking level used with `model`: scans back because a user message
 * submitted without re-picking a choice drops the key at the JSON round trip,
 * while its preceding assistant turn still carries it. Unsupported levels never restore.
 */
const findLastUsedThinkingSelection = (
	messages: SessionMessage[],
	model: ChatModelSelection
): ThinkingSelection => {
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
		const thinking = normalizeSelectionChoice(model, metadata.thinkingLevel);
		if (hasThinkingSelection(thinking)) {
			return thinking;
		}
	}
	return {};
};

const normalizeSelection = (model: unknown): ChatModelSelection | null => {
	if (isString(model)) {
		return normalizeChatModelSelection(model);
	}

	if (isPlainObject(model)) {
		const parsed = modelSelectionSchema.safeParse(model);
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
	messages: SessionMessage[]
): SessionMessage["metadata"] | undefined =>
	messages.findLast(
		(message) =>
			sessionMessageMetadataSchema.safeParse(message.metadata).success
	)?.metadata;

/**
 * Resolves the Skill payload the current user turn carries for the model loop.
 * Sanitized activation metadata without instructions means the Skill no longer
 * applies and returns `undefined`.
 */
export const getOriginatingUserSkill = (
	messages: SessionMessage[]
): SkillRequestContext | undefined => {
	const message = [...messages].reverse().find(({ role }) => role === "user");
	const parsed = sessionMessageSkillSchema.safeParse(message?.metadata?.skill);
	if (!parsed.success) {
		return;
	}
	const skill = parsed.data;
	if (!("instructions" in skill)) {
		return;
	}
	return {
		contentHash: skill.contentHash,
		instructions: skill.instructions,
		name: skill.name,
		source: skill.source ?? "explicit",
	};
};

export type ResolvedSessionSelection = {
	agent: AgentId | undefined;
	persistedAgent: AgentId | undefined;
	model: ChatModelSelection;
	thinkingLevel: ThinkingLevel | undefined;
};

export type SessionSelectionRefs = {
	agent?: AgentId;
	model?: ChatModelSelection;
	thinkingLevel?: ThinkingLevel;
};

type ResolveSessionSelectionInput = {
	messages: SessionMessage[];
	resolveAgent?: (agentId: AgentId | undefined) => AgentId;
	sessionModel?: ChatModelSelection;
	sessionThinkingLevel?: ThinkingLevel;
	refs?: SessionSelectionRefs;
};

/**
 * Resolves the selection a session uses, merging sources in a fixed
 * order — session row, then message metadata, then prompt-config refs —
 * for each field. Agent has no session-row source, so it merges messages
 * then refs, and passes through `resolveAgent` when the caller wants it
 * resolved against an Agent registry.
 * Returns null when no source carries a model.
 */
export const resolveSessionSelection = ({
	messages,
	resolveAgent,
	sessionModel,
	sessionThinkingLevel,
	refs,
}: ResolveSessionSelectionInput): ResolvedSessionSelection | null => {
	const persisted = getLastUsedSelection(messages);
	const model = sessionModel ?? persisted?.model ?? refs?.model;
	if (!model) {
		return null;
	}
	const persistedAgent = persisted?.agent ?? refs?.agent;
	const agent =
		resolveAgent && !isUndefined(persistedAgent)
			? resolveAgent(persistedAgent)
			: persistedAgent;
	const sessionChoice = normalizeSelectionChoice(model, sessionThinkingLevel);
	const messageChoice = normalizeSelectionChoice(
		model,
		persisted?.thinkingLevel
	);
	const refsChoice = normalizeSelectionChoice(model, refs?.thinkingLevel);
	let choice = refsChoice;
	if (hasThinkingSelection(messageChoice)) {
		choice = messageChoice;
	}
	if (hasThinkingSelection(sessionChoice)) {
		choice = sessionChoice;
	}
	return {
		agent,
		persistedAgent,
		model,
		thinkingLevel: choice.thinkingLevel,
	};
};

const normalizeSelectionChoice = (
	model: ChatModelSelection,
	thinkingLevel: ThinkingLevel | undefined
): ThinkingSelection =>
	isUndefined(thinkingLevel)
		? {}
		: normalizeThinkingSelection(model, { thinkingLevel });

const hasThinkingSelection = (choice: ThinkingSelection): boolean =>
	choice.thinkingLevel !== undefined;

/**
 * Restores the prompt config used by the newest message. Session-row values
 * remain a fallback when no usable message metadata is available.
 * This policy is intentionally narrower than resolveSessionSelection:
 * Home uses it for the next-chat default, while active sessions retain
 * the session-row choice/effective-message two-tier policy.
 */
export const resolveLastUsedSessionSelection = ({
	messages,
	resolveAgent,
	sessionModel,
	sessionThinkingLevel,
	refs,
}: ResolveSessionSelectionInput): ResolvedSessionSelection | null => {
	const persisted = getLastUsedSelection(messages);
	if (!persisted) {
		return resolveSessionSelection({
			messages,
			resolveAgent,
			sessionModel,
			sessionThinkingLevel,
			refs,
		});
	}

	return {
		agent: resolveAgent ? resolveAgent(persisted.agent) : persisted.agent,
		persistedAgent: persisted.agent,
		model: persisted.model,
		thinkingLevel: persisted.thinkingLevel,
	};
};

export type SelectionFallback = {
	agent: AgentId;
	model: ChatModelSelection;
	thinkingLevel?: ThinkingLevel;
	skill?: SkillRequestContext;
};

export type OutgoingChatSelection = {
	agent: AgentId | undefined;
	model: ChatModelSelection | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	skill: SkillRequestContext | undefined;
};

/**
 * The selection a new turn sends: the last message's own metadata wins,
 * then the newest schema-valid metadata, then the transport fallback.
 * The Skill falls back to the transport-provided snapshot the same way.
 */
export const resolveOutgoingSelection = (
	messages: SessionMessage[],
	fallback?: SelectionFallback
): OutgoingChatSelection => {
	const message = messages.at(-1);
	if (!message) {
		throw new Error("No message to send");
	}

	const metadata = findLastValidMetadata(messages);
	const model =
		normalizeSelection(message.metadata?.model) ??
		normalizeSelection(metadata?.model) ??
		fallback?.model;
	const messageChoice = model
		? normalizeSelectionChoice(model, message.metadata?.thinkingLevel)
		: {};
	const metadataChoice = model
		? normalizeSelectionChoice(model, metadata?.thinkingLevel)
		: {};
	const fallbackChoice = model
		? normalizeSelectionChoice(model, fallback?.thinkingLevel)
		: {};
	let choice = fallbackChoice;
	if (hasThinkingSelection(metadataChoice)) {
		choice = metadataChoice;
	}
	if (hasThinkingSelection(messageChoice)) {
		choice = messageChoice;
	}
	return {
		agent: message.metadata?.agent ?? metadata?.agent ?? fallback?.agent,
		model,
		thinkingLevel: choice.thinkingLevel,
		skill: getOriginatingUserSkill(messages) ?? fallback?.skill,
	};
};

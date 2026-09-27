import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	type Effort,
	modelSelectionSchema,
	normalizeChatModelSelection,
	normalizeReasoningSelection,
	type ReasoningMode,
	type ReasoningSelection,
} from "@wincode/ai/models";
import { isPlainObject, isString, isUndefined } from "@wincode/runtime-utils";
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
	effort?: Effort;
	reasoningMode?: ReasoningMode;
};

/**
 * The last selection actually used in a session: agent and model come
 * from the newest message that carries both; the Effort or Reasoning Mode
 * scans back to the last choice used with that model, because a user message
 * submitted without re-picking a choice drops those keys at the JSON round trip.
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

	const reasoning = findLastUsedReasoningSelection(messages, selection.model);
	return { ...selection, ...reasoning };
};

/**
 * The last Effort or Reasoning Mode used with `model`: scans back because a
 * user message submitted without re-picking a choice drops the key at the JSON
 * round trip, while its preceding assistant turn still carries it. Choices
 * are normalized against the resolved model so unsupported pairs never restore.
 */
const findLastUsedReasoningSelection = (
	messages: SessionMessage[],
	model: ChatModelSelection
): ReasoningSelection => {
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
		const reasoning = normalizeSelectionChoice(
			model,
			metadata.effort,
			metadata.reasoningMode
		);
		if (hasReasoningSelection(reasoning)) {
			return reasoning;
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
		arguments: skill.arguments,
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
	effort: Effort | undefined;
	reasoningMode: ReasoningMode | undefined;
};

export type SessionSelectionRefs = {
	agent?: AgentId;
	model?: ChatModelSelection;
	effort?: Effort;
	reasoningMode?: ReasoningMode;
};

type ResolveSessionSelectionInput = {
	messages: SessionMessage[];
	resolveAgent?: (agentId: AgentId | undefined) => AgentId;
	sessionModel?: ChatModelSelection;
	sessionEffort?: Effort;
	sessionReasoningMode?: ReasoningMode;
	refs?: SessionSelectionRefs;
};

/**
 * Resolves the selection a session uses, merging sources in a fixed
 * order — session row, then message metadata, then prompt-config refs —
 * for each field. Agent has no session-row source, so it merges messages
 * then refs, and passes through `resolveAgent` when the caller wants it
 * resolved against an Agent registry. Session-row Effort/Mode values take
 * precedence over message metadata as one mutually-exclusive selection pair.
 * Returns null when no source carries a model.
 */
export const resolveSessionSelection = ({
	messages,
	resolveAgent,
	sessionModel,
	sessionEffort,
	sessionReasoningMode,
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
	const sessionChoice = normalizeSelectionChoice(
		model,
		sessionEffort,
		sessionReasoningMode
	);
	const messageChoice = normalizeSelectionChoice(
		model,
		persisted?.effort,
		persisted?.reasoningMode
	);
	const refsChoice = normalizeSelectionChoice(
		model,
		refs?.effort,
		refs?.reasoningMode
	);
	let choice = refsChoice;
	if (hasReasoningSelection(messageChoice)) {
		choice = messageChoice;
	}
	if (hasReasoningSelection(sessionChoice)) {
		choice = sessionChoice;
	}
	return {
		agent,
		persistedAgent,
		model,
		effort: choice.effort,
		reasoningMode: choice.reasoningMode,
	};
};

const normalizeSelectionChoice = (
	model: ChatModelSelection,
	effort: Effort | undefined,
	reasoningMode: ReasoningMode | undefined
): ReasoningSelection => {
	if (!(isUndefined(effort) || isUndefined(reasoningMode))) {
		return {};
	}
	if (!isUndefined(effort)) {
		return normalizeReasoningSelection(model, { effort });
	}
	if (!isUndefined(reasoningMode)) {
		return normalizeReasoningSelection(model, { reasoningMode });
	}
	return {};
};

const hasReasoningSelection = (choice: ReasoningSelection): boolean =>
	choice.effort !== undefined || choice.reasoningMode !== undefined;

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
	sessionEffort,
	sessionReasoningMode,
	refs,
}: ResolveSessionSelectionInput): ResolvedSessionSelection | null => {
	const persisted = getLastUsedSelection(messages);
	if (!persisted) {
		return resolveSessionSelection({
			messages,
			resolveAgent,
			sessionModel,
			sessionEffort,
			sessionReasoningMode,
			refs,
		});
	}

	return {
		agent: resolveAgent ? resolveAgent(persisted.agent) : persisted.agent,
		persistedAgent: persisted.agent,
		model: persisted.model,
		effort: persisted.effort,
		reasoningMode: persisted.reasoningMode,
	};
};

export type SelectionFallback = {
	agent: AgentId;
	model: ChatModelSelection;
	effort?: Effort;
	reasoningMode?: ReasoningMode;
	skill?: SkillRequestContext;
};

export type OutgoingChatSelection = {
	agent: AgentId | undefined;
	model: ChatModelSelection | undefined;
	effort: Effort | undefined;
	reasoningMode: ReasoningMode | undefined;
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
		? normalizeSelectionChoice(
				model,
				message.metadata?.effort,
				message.metadata?.reasoningMode
			)
		: {};
	const metadataChoice = model
		? normalizeSelectionChoice(model, metadata?.effort, metadata?.reasoningMode)
		: {};
	const fallbackChoice = model
		? normalizeSelectionChoice(model, fallback?.effort, fallback?.reasoningMode)
		: {};
	let choice = fallbackChoice;
	if (hasReasoningSelection(metadataChoice)) {
		choice = metadataChoice;
	}
	if (hasReasoningSelection(messageChoice)) {
		choice = messageChoice;
	}
	return {
		agent: message.metadata?.agent ?? metadata?.agent ?? fallback?.agent,
		model,
		effort: choice.effort,
		reasoningMode: choice.reasoningMode,
		skill: getOriginatingUserSkill(messages) ?? fallback?.skill,
	};
};

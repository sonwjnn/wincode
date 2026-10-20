import { type AgentId, agentIdSchema } from "@wincode/agent-core";
import {
	type ThinkingLevel,
	type ThinkingSelection,
	thinkingLevelSchema,
} from "@wincode/ai";
import {
	isPlainObject,
	isString,
	isUndefined,
	omitUndefined,
} from "@wincode/utils";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import {
	DEFAULT_PROVIDER_MODEL_SELECTION,
	isSameProviderModelIdentity,
	normalizeProviderModelSelection,
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { SkillRequestContext } from "@/modules/skills";
import type { SessionMessage } from "./message";
import {
	sessionMessageMetadataSchema,
	sessionMessageSkillSchema,
} from "./message";

/**
 * The session-selection module owns model, Agent, and ThinkingLevel precedence
 * for SDK defaults, restored Sessions, message metadata, and outgoing turns.
 * It also owns the Skill context a new turn inherits from message metadata.
 *
 * Two policies intentionally coexist here:
 * - restore reads leniently — a selection survives partially broken metadata;
 * - the request body reads strictly — only schema-valid pairs reach the send.
 */

export type LastUsedSelection = {
	agent: AgentId;
	model: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
};

export type SessionSdkSelectionDefaults = Readonly<{
	agent: AgentId;
	model: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;

export type SessionSdkSelectionOptions = Readonly<{
	agent?: AgentId | string;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;

const parseSelectionAgent = (value: AgentId | string): AgentId => {
	const parsed = agentIdSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`Invalid Agent Identifier: ${value}`);
	}
	return parsed.data;
};

/** Resolves the current SDK defaults from explicit, Agent, then product defaults. */
export const resolveSessionSdkSelectionDefaults = (
	registry: AgentRegistry | null,
	options: SessionSdkSelectionOptions
): SessionSdkSelectionDefaults => {
	const agent =
		options.agent === undefined
			? (registry?.defaultAgentId ?? DEFAULT_AGENT_ID)
			: parseSelectionAgent(options.agent);
	const selectedAgent = registry?.agents.find(
		(candidate) => candidate.id === agent
	);
	const model =
		options.model ?? selectedAgent?.model ?? DEFAULT_PROVIDER_MODEL_SELECTION;
	return {
		agent,
		model,
		...omitUndefined({
			thinkingLevel: normalizeSelectionChoice(
				model,
				options.thinkingLevel ?? selectedAgent?.thinkingLevel
			).thinkingLevel,
		}),
	};
};

/** Restores an SDK handle's next-turn defaults without replacing stored identity. */
export const resolveRestoredSessionSdkSelection = (
	fallback: SessionSdkSelectionDefaults,
	stored: Readonly<{
		model?: ProviderModelSelection;
		thinkingLevel?: ThinkingLevel;
	}>,
	prior: Pick<
		ResolvedSessionSelection,
		"agent" | "model" | "thinkingLevel"
	> | null
): SessionSdkSelectionDefaults => {
	const model = prior?.model ?? stored.model ?? fallback.model;
	return {
		agent: prior?.agent ?? fallback.agent,
		model,
		...omitUndefined({
			thinkingLevel: normalizeSelectionChoice(
				model,
				prior?.thinkingLevel ?? stored.thinkingLevel ?? fallback.thinkingLevel
			).thinkingLevel,
		}),
	};
};

/** Resolves one SDK prompt against the defaults restored for its open handle. */
export const resolveSessionSdkPromptSelection = (
	input: SessionSdkSelectionOptions,
	defaults: SessionSdkSelectionDefaults
): SessionSdkSelectionDefaults => {
	const model = input.model ?? defaults.model;
	return {
		agent:
			input.agent === undefined
				? defaults.agent
				: parseSelectionAgent(input.agent),
		model,
		...omitUndefined({
			thinkingLevel: normalizeSelectionChoice(
				model,
				input.thinkingLevel ?? defaults.thinkingLevel
			).thinkingLevel,
		}),
	};
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
	let selection: { agent: AgentId; model: ProviderModelSelection } | undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const metadata = messages[index]?.metadata;
		if (!metadata?.model) {
			continue;
		}

		const agent = metadata.agent;
		if (!agent) {
			continue;
		}

		const model = normalizeProviderModelSelection(metadata.model);
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
	model: ProviderModelSelection
): ThinkingSelection => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const metadata = messages[index]?.metadata;
		if (!metadata?.model) {
			continue;
		}
		const metadataModel = normalizeProviderModelSelection(metadata.model);
		if (!(metadataModel && isSameProviderModelIdentity(metadataModel, model))) {
			continue;
		}
		const thinking = normalizeSelectionChoice(model, metadata.thinkingLevel);
		if (hasThinkingSelection(thinking)) {
			return thinking;
		}
	}
	return {};
};

const normalizeSelection = (model: unknown): ProviderModelSelection | null => {
	if (isString(model)) {
		return parseProviderModelSelection(model);
	}

	if (isPlainObject(model)) {
		return normalizeProviderModelSelection(model);
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

/**
 * Parses one Thinking Level against the model that will run it, or throws when
 * the level is not one the model supports.
 */
export const strictThinkingSelection = (value: unknown): ThinkingSelection => {
	if (value === undefined) {
		return {};
	}
	const parsed = thinkingLevelSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("Thinking level is unavailable for the selected model.");
	}
	return { thinkingLevel: parsed.data };
};

export type ResolvedSessionSelection = {
	agent: AgentId | undefined;
	persistedAgent: AgentId | undefined;
	model: ProviderModelSelection;
	thinkingLevel: ThinkingLevel | undefined;
};

export type SessionSelectionRefs = {
	agent?: AgentId;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
};

type ResolveSessionSelectionInput = {
	messages: SessionMessage[];
	resolveAgent?: (agentId: AgentId | undefined) => AgentId;
	sessionModel?: ProviderModelSelection;
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
	_model: ProviderModelSelection,
	thinkingLevel: ThinkingLevel | undefined
): ThinkingSelection => {
	if (isUndefined(thinkingLevel)) {
		return {};
	}
	const parsed = thinkingLevelSchema.safeParse(thinkingLevel);
	return parsed.success ? { thinkingLevel: parsed.data } : {};
};

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
	model: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
	skill?: SkillRequestContext;
};

export type OutgoingChatSelection = {
	agent: AgentId | undefined;
	model: ProviderModelSelection | undefined;
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

import { type AgentId, agentIdSchema } from "@wincode/agent-core";
import {
	type ThinkingLevel,
	type ThinkingSelection,
	thinkingLevelSchema,
} from "@wincode/ai";
import { isUndefined, omitUndefined } from "@wincode/utils";
import { DEFAULT_AGENT_ID } from "@/modules/agents/built-ins";
import type { AgentRegistry } from "@/modules/agents/registry";
import {
	DEFAULT_PROVIDER_MODEL_SELECTION,
	isSameProviderModelIdentity,
	normalizeProviderModelSelection,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { SkillRequestContext } from "@/modules/skills";
import type { SessionMessage } from "./message";
import { sessionMessageSkillSchema } from "./message";

/**
 * The Session Selection module owns Model, Agent, and ThinkingLevel precedence
 * for the tiers a Session records.
 *
 * One order table serves every caller. Model and ThinkingLevel merge the
 * session row, then message metadata, then prompt-config refs; Agent has no
 * session-row tier and merges message metadata, then prompt-config refs.
 * `restoreSelection` also reports the tier that supplied the Model, so a caller
 * can tell a restored choice from a prompt-config ref without re-deriving the
 * order.
 *
 * Defaults for a Session that never recorded a choice are a separate question:
 * `sessionSelectionDefaults` resolves them, and each caller composes them with
 * a restore in the order its mode requires. Provider availability, provider
 * ownership, and how a bad selection is surfaced stay with the caller.
 */

export type SelectionSource = "row" | "message" | "refs";

export type SessionSelectionRefs = Readonly<{
	agent?: AgentId;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;

export type SessionSelectionMaterial = Readonly<{
	messages: readonly SessionMessage[];
	/** The caller's current prompt-config selection. */
	refs?: SessionSelectionRefs;
	/** Resolve a recorded Agent against the live registry. */
	resolveAgent?: (agentId: AgentId) => AgentId;
	/** The durable session row, which records the session-level choice. */
	row?: Readonly<{
		model?: ProviderModelSelection;
		thinkingLevel?: ThinkingLevel;
	}>;
}>;

export type ResolvedSessionSelection = Readonly<{
	agent: AgentId | undefined;
	persistedAgent: AgentId | undefined;
	model: ProviderModelSelection;
	thinkingLevel: ThinkingLevel | undefined;
}>;

export type SessionSelection = ResolvedSessionSelection &
	Readonly<{ source: SelectionSource }>;

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
 * The last selection actually used in a session: agent and model come
 * from the newest message that carries both; the Thinking level scans back
 * to the last choice used with that model, because a user message submitted
 * without re-picking a choice drops that key at the JSON round trip.
 */
const getLastUsedSelection = (
	messages: readonly SessionMessage[]
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
	messages: readonly SessionMessage[],
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

/** The tier that supplies the Model, and the Model itself, in one decision. */
const selectionTier = (
	rowModel: ProviderModelSelection | undefined,
	messageModel: ProviderModelSelection | undefined,
	refsModel: ProviderModelSelection | undefined
): readonly [SelectionSource, ProviderModelSelection | undefined] => {
	if (rowModel !== undefined) {
		return ["row", rowModel];
	}
	if (messageModel !== undefined) {
		return ["message", messageModel];
	}
	return ["refs", refsModel];
};

/**
 * The selection a Session restores from its recorded tiers, merging sources in
 * one fixed order per value — session row, then message metadata, then
 * prompt-config refs. Agent has no session-row source, so it merges messages
 * then refs, and passes through `resolveAgent` when the caller wants it
 * resolved against an Agent registry.
 *
 * Returns null when no tier carries a Model, so a caller can tell a Session
 * that never recorded a choice from one that did. A caller that wants a
 * defaulted selection composes `sessionSelectionDefaults` with this result in
 * its own order.
 */
export const restoreSelection = (
	material: SessionSelectionMaterial
): SessionSelection | null => {
	const rowModel = material.row?.model;
	const persisted = getLastUsedSelection(material.messages);
	const [source, model] = selectionTier(
		rowModel,
		persisted?.model,
		material.refs?.model
	);
	if (model === undefined) {
		return null;
	}

	const persistedAgent = persisted?.agent ?? material.refs?.agent;
	const agent =
		material.resolveAgent && !isUndefined(persistedAgent)
			? material.resolveAgent(persistedAgent)
			: persistedAgent;

	const sessionChoice = normalizeSelectionChoice(
		model,
		material.row?.thinkingLevel
	);
	const messageChoice = normalizeSelectionChoice(
		model,
		persisted?.thinkingLevel
	);
	const refsChoice = normalizeSelectionChoice(
		model,
		material.refs?.thinkingLevel
	);
	let choice = refsChoice;
	if (hasThinkingSelection(messageChoice)) {
		choice = messageChoice;
	}
	if (hasThinkingSelection(sessionChoice)) {
		choice = sessionChoice;
	}

	return {
		agent,
		model,
		persistedAgent,
		source,
		thinkingLevel: choice.thinkingLevel,
	};
};

/**
 * Restores the prompt config used by the newest message for the next chat.
 * This policy is deliberately narrower than `restoreSelection`: Home adopts
 * the newest complete message pair alone, and only falls back to the stored
 * tiers when no such pair exists. Session-row values remain the fallback there.
 */
export const nextChatSelection = (
	material: SessionSelectionMaterial
): SessionSelection | null => {
	const persisted = getLastUsedSelection(material.messages);
	if (!persisted) {
		return restoreSelection(material);
	}

	return {
		agent: material.resolveAgent
			? material.resolveAgent(persisted.agent)
			: persisted.agent,
		model: persisted.model,
		persistedAgent: persisted.agent,
		source: "message",
		thinkingLevel: persisted.thinkingLevel,
	};
};

/**
 * Resolves the defaults for a Session that has not recorded a choice: the
 * explicit option, then the selected Agent's own pin, then the product default.
 * ThinkingLevel follows the same order and never restores a level the selected
 * Model cannot run.
 */
export const sessionSelectionDefaults = (
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
 * The Model a Session may restore to, or nothing when the selected Agent's pin
 * no longer matches the restored Model. This is the restore guard: a Session
 * restores only a choice it can still run.
 */
export const restorableSelectionModel = (
	selection: Pick<ResolvedSessionSelection, "model"> | null,
	pinnedModel: ProviderModelSelection | undefined
): ProviderModelSelection | undefined => {
	if (selection === null || pinnedModel === undefined) {
		return;
	}
	return isSameProviderModelIdentity(selection.model, pinnedModel)
		? selection.model
		: undefined;
};

/**
 * Resolves the Skill payload the current user turn carries for the model loop.
 * Sanitized activation metadata without instructions means the Skill no longer
 * applies and returns `undefined`.
 */
export const getOriginatingUserSkill = (
	messages: readonly SessionMessage[]
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

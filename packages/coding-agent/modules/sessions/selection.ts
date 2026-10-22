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

type LastUsedSelection = {
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

const normalizeThinkingLevel = (
	thinkingLevel: ThinkingLevel | undefined
): ThinkingLevel | undefined => {
	if (isUndefined(thinkingLevel)) {
		return;
	}
	const parsed = thinkingLevelSchema.safeParse(thinkingLevel);
	return parsed.success ? parsed.data : undefined;
};

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
		const thinkingLevel = normalizeThinkingLevel(metadata.thinkingLevel);
		if (thinkingLevel !== undefined) {
			return { thinkingLevel };
		}
	}
	return {};
};

type RecordedTier = Readonly<{
	source: SelectionSource;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;

const messageTier = (
	persisted: LastUsedSelection | undefined
): RecordedTier => ({
	source: "message",
	model: persisted?.model,
	thinkingLevel: persisted?.thinkingLevel,
});

/** The recorded tiers, highest precedence first. Agent has no session-row tier. */
const recordedTiers = (
	material: SessionSelectionMaterial,
	persisted: LastUsedSelection | undefined
): readonly RecordedTier[] => [
	{
		source: "row",
		model: material.row?.model,
		thinkingLevel: material.row?.thinkingLevel,
	},
	messageTier(persisted),
	{
		source: "refs",
		model: material.refs?.model,
		thinkingLevel: material.refs?.thinkingLevel,
	},
];

const firstThinkingLevel = (
	tiers: readonly RecordedTier[]
): ThinkingLevel | undefined => {
	for (const tier of tiers) {
		const thinkingLevel = normalizeThinkingLevel(tier.thinkingLevel);
		if (thinkingLevel !== undefined) {
			return thinkingLevel;
		}
	}
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
	const persisted = getLastUsedSelection(material.messages);
	const tiers = recordedTiers(material, persisted);
	const modelTier = tiers.find((tier) => tier.model !== undefined);
	if (modelTier?.model === undefined) {
		return null;
	}
	const model = modelTier.model;

	const persistedAgent = persisted?.agent ?? material.refs?.agent;
	const agent =
		material.resolveAgent && !isUndefined(persistedAgent)
			? material.resolveAgent(persistedAgent)
			: persistedAgent;

	return {
		agent,
		model,
		persistedAgent,
		source: modelTier.source,
		thinkingLevel: firstThinkingLevel(tiers),
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
	const tier = messageTier(persisted);
	if (persisted === undefined || tier.model === undefined) {
		return restoreSelection(material);
	}

	return {
		agent: material.resolveAgent
			? material.resolveAgent(persisted.agent)
			: persisted.agent,
		model: tier.model,
		persistedAgent: persisted.agent,
		source: tier.source,
		thinkingLevel: normalizeThinkingLevel(tier.thinkingLevel),
	};
};

/**
 * Resolves the defaults for a Session that has not recorded a choice: the
 * explicit option, then the selected Agent's own pin, then the product default.
 * ThinkingLevel follows the same order.
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
			thinkingLevel: normalizeThinkingLevel(
				options.thinkingLevel ?? selectedAgent?.thinkingLevel
			),
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
			thinkingLevel: normalizeThinkingLevel(
				prior?.thinkingLevel ?? stored.thinkingLevel ?? fallback.thinkingLevel
			),
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
			thinkingLevel: normalizeThinkingLevel(
				input.thinkingLevel ?? defaults.thinkingLevel
			),
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

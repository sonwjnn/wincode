import type { AgentId } from "@wincode/agent-core";
import type { ProviderModel, ThinkingSelection } from "@wincode/ai";
import { omitUndefined } from "@wincode/utils";
import {
	isAvailableProviderModelSelection,
	isPluginProviderSelectionBoundToTrustedOwner,
	isSameProviderModelIdentity,
	type PluginProviderOwnerRegistration,
	type ProviderModelSelection,
	resolveProviderModelSelectionForHost,
} from "@/modules/providers/provider-model-selection";
import type { ResolvedCodingAgent } from "./built-ins";
import type { AgentRegistry } from "./registry";

export type AgentCallSelection = {
	readonly agent: AgentId;
	readonly model: ProviderModelSelection;
} & ThinkingSelection;

export type PreparedAgentCall = AgentCallSelection & {
	readonly resolvedAgent: ResolvedCodingAgent;
};

export type EffectiveAgentSelection = {
	readonly agent: AgentId;
	readonly model: ProviderModelSelection;
	readonly resolvedAgent?: ResolvedCodingAgent;
	readonly unavailableReason?: string;
} & ThinkingSelection;

/** Composer-level choices that intentionally take precedence over Agent defaults. */
export type AgentSelectionOverride = Readonly<{
	model?: ProviderModelSelection;
	thinking?: ThinkingSelection;
}>;

/** Allows the Agent's exact pin only after the Provider SDK confirms it is available. */
export const withAvailableAgentModelOverride = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	selectionOverride: AgentSelectionOverride | undefined,
	availableProviderModels: readonly ProviderModel[] | undefined
): AgentSelectionOverride | undefined => {
	if (
		selectionOverride?.model !== undefined ||
		availableProviderModels === undefined
	) {
		return selectionOverride;
	}
	const pinnedModel = registry?.agents.find(({ id }) => id === agentId)?.model;
	if (
		pinnedModel === undefined ||
		!isAvailableProviderModelSelection(pinnedModel, availableProviderModels)
	) {
		return selectionOverride;
	}
	return { ...selectionOverride, model: pinnedModel };
};

const hasUnavailableAgentModel = (
	agent: AgentRegistry["agents"][number] | undefined,
	allowSubagent: boolean
): boolean => {
	if (agent === undefined || agent.model === undefined) {
		return false;
	}
	return !(agent.isAvailable && (allowSubagent || agent.isSelectable));
};

const unavailableAgentReason = (
	agent: AgentRegistry["agents"][number] | undefined,
	allowSubagent: boolean
): string | undefined => {
	if (agent === undefined || !hasUnavailableAgentModel(agent, allowSubagent)) {
		return;
	}
	return (
		agent.unavailableReason ?? `Agent ${agent.displayName} is unavailable.`
	);
};

const thinkingSelectionForAgent = (
	agent: AgentRegistry["agents"][number] | undefined,
	fallback: ThinkingSelection,
	override: AgentSelectionOverride | undefined
): ThinkingSelection => {
	if (override?.thinking !== undefined) {
		return override.thinking;
	}
	if (agent?.model === undefined) {
		return fallback;
	}
	if (
		override?.model !== undefined &&
		!isSameProviderModelIdentity(override.model, agent.model)
	) {
		return fallback;
	}
	return agent.thinkingLevel === undefined
		? {}
		: { thinkingLevel: agent.thinkingLevel };
};

const resolvedAgentFor = (
	agent: AgentRegistry["agents"][number] | undefined,
	allowSubagent: boolean
): ResolvedCodingAgent | undefined => {
	if (agent === undefined) {
		return;
	}
	const isAvailable =
		agent.isAvailable && (allowSubagent || agent.isSelectable);
	if (!isAvailable) {
		return;
	}
	return {
		id: agent.id,
		instructions: agent.instructions,
		role: agent.role,
		visibleCodingTools: [...agent.visibleCodingTools],
	};
};

export const resolveEffectiveAgentSelection = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	fallbackModel: ProviderModelSelection,
	fallbackSelection: ThinkingSelection,
	allowSubagent = false,
	selectionOverride?: AgentSelectionOverride
): EffectiveAgentSelection => {
	const requested = registry?.agents.find(
		(agent) =>
			agent.id === agentId && (allowSubagent || agent.role !== "subagent")
	);
	const fallbackAgent = registry?.agents.find(
		(agent) => agent.id === "build" && agent.isAvailable && agent.isSelectable
	);
	let selected = fallbackAgent;
	if (hasUnavailableAgentModel(requested, allowSubagent)) {
		selected = requested;
	} else if (
		requested?.isAvailable &&
		(requested.isSelectable || allowSubagent)
	) {
		selected = requested;
	}
	const model = selectionOverride?.model ?? selected?.model ?? fallbackModel;
	const thinkingSelection = thinkingSelectionForAgent(
		selected,
		fallbackSelection,
		selectionOverride
	);
	return {
		agent: selected?.id ?? agentId,
		model,
		...omitUndefined({
			resolvedAgent: resolvedAgentFor(selected, allowSubagent),
			unavailableReason: unavailableAgentReason(requested, allowSubagent),
		}),
		...thinkingSelection,
	};
};

/**
 * Resolves a fresh Interactive Agent pin before Provider availability is read.
 * Restored Session models remain strict so their Plugin owner is never inferred.
 */
export const resolveInteractiveAgentSelection = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	fallbackModel: ProviderModelSelection,
	fallbackSelection: ThinkingSelection,
	selectionOverride: AgentSelectionOverride | undefined,
	trustedProviderRegistrations: readonly PluginProviderOwnerRegistration[],
	restoredModel?: ProviderModelSelection,
	allowSubagent = false,
	hostProviderRegistrations?: (
		providerId: string
	) => readonly PluginProviderOwnerRegistration[] | undefined
): EffectiveAgentSelection => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		agentId,
		fallbackModel,
		fallbackSelection,
		allowSubagent,
		selectionOverride
	);
	const selectedAgent = registry?.agents.find(
		(candidate) => candidate.id === effective.agent
	);
	const selectedAgentPin =
		selectionOverride?.model === undefined &&
		selectedAgent?.model !== undefined &&
		isSameProviderModelIdentity(selectedAgent.model, effective.model);
	const isRestoredModel =
		selectionOverride?.model === undefined &&
		restoredModel !== undefined &&
		isSameProviderModelIdentity(restoredModel, effective.model);
	const model =
		isRestoredModel && restoredModel !== undefined
			? restoredModel
			: effective.model;
	const resolvedModel = resolveProviderModelSelectionForHost(
		model,
		trustedProviderRegistrations,
		selectedAgentPin && !isRestoredModel
	);
	if (resolvedModel === undefined) {
		throw new Error("Could not verify the selected Provider SDK Model.");
	}
	const collectionRegistrations = hostProviderRegistrations?.(
		resolvedModel.providerId
	);
	if (
		hostProviderRegistrations !== undefined &&
		!isPluginProviderSelectionBoundToTrustedOwner(
			resolvedModel,
			trustedProviderRegistrations,
			collectionRegistrations
		)
	) {
		throw new Error(
			`Plugin Provider model selection ${resolvedModel.providerId}/${resolvedModel.modelId} is not bound to its trusted source in this Session Host.`
		);
	}
	return { ...effective, model: resolvedModel };
};

export const prepareAgentCall = (
	registry: AgentRegistry | null,
	selection: AgentCallSelection,
	options?: { readonly allowSubagent?: boolean }
): PreparedAgentCall => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		selection.agent,
		selection.model,
		selection,
		options?.allowSubagent ?? false
	);
	if (!effective.resolvedAgent) {
		throw new Error("No resolved Agent or model to send");
	}
	return {
		agent: effective.agent,
		model: effective.model,
		...(effective.thinkingLevel === undefined
			? {}
			: { thinkingLevel: effective.thinkingLevel }),
		resolvedAgent: effective.resolvedAgent,
	};
};

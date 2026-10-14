import type { AgentId } from "@wincode/agent-core";
import type { ThinkingSelection } from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import { omitUndefined } from "@wincode/utils";
import {
	catalogSelectionForProviderModel,
	normalizeProviderThinkingSelection,
	type ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import type { ResolvedCodingAgent } from "./built-ins";
import {
	type AgentRegistry,
	agentUnavailableReasonWithoutModelPin,
	canDeferAgentModelAvailability,
} from "./registry";

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
		!availableProviderModels.some(
			(model) =>
				model.providerId === pinnedModel.providerId &&
				model.modelId === pinnedModel.modelId
		)
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
	allowSubagent: boolean,
	allowUnavailablePinReplacement: boolean,
	allowModelAvailabilityDeferral: boolean
): string | undefined => {
	if (
		agent === undefined ||
		!hasUnavailableAgentModel(agent, allowSubagent) ||
		(allowUnavailablePinReplacement &&
			agent.modelUnavailableReason !== undefined &&
			agentUnavailableReasonWithoutModelPin(agent) === undefined) ||
		(allowModelAvailabilityDeferral && canDeferAgentModelAvailability(agent))
	) {
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
		(override.model.modelId !== agent.model.modelId ||
			override.model.providerId !== agent.model.providerId)
	) {
		return fallback;
	}
	return agent.thinkingLevel === undefined
		? {}
		: { thinkingLevel: agent.thinkingLevel };
};

const resolvedAgentFor = (
	agent: AgentRegistry["agents"][number] | undefined,
	allowSubagent: boolean,
	allowUnavailablePinReplacement: boolean,
	allowModelAvailabilityDeferral: boolean
): ResolvedCodingAgent | undefined => {
	if (agent === undefined) {
		return;
	}
	const isAvailable =
		agent.isAvailable && (allowSubagent || agent.isSelectable);
	const isUnavailablePinReplacement =
		allowUnavailablePinReplacement &&
		agent.modelUnavailableReason !== undefined &&
		agentUnavailableReasonWithoutModelPin(agent) === undefined;
	const isDeferredModelAvailability =
		allowModelAvailabilityDeferral && canDeferAgentModelAvailability(agent);
	if (
		!(isAvailable || isUnavailablePinReplacement || isDeferredModelAvailability)
	) {
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
	selectionOverride?: AgentSelectionOverride,
	options?: Readonly<{ allowModelAvailabilityDeferral?: boolean }>
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
	const allowUnavailablePinReplacement =
		selectionOverride?.model !== undefined &&
		hasUnavailableAgentModel(requested, allowSubagent) &&
		requested?.modelUnavailableReason !== undefined &&
		agentUnavailableReasonWithoutModelPin(requested) === undefined;
	const hasSelectionOverride =
		selectionOverride?.model !== undefined ||
		selectionOverride?.thinking !== undefined;
	const allowModelAvailabilityDeferral =
		options?.allowModelAvailabilityDeferral === true;
	const thinkingSelection = thinkingSelectionForAgent(
		selected,
		fallbackSelection,
		selectionOverride
	);
	const resolvedThinkingSelection =
		hasSelectionOverride && catalogSelectionForProviderModel(model) !== null
			? normalizeProviderThinkingSelection(model, thinkingSelection)
			: thinkingSelection;
	return {
		agent: selected?.id ?? agentId,
		model,
		...omitUndefined({
			resolvedAgent: resolvedAgentFor(
				selected,
				allowSubagent,
				allowUnavailablePinReplacement,
				allowModelAvailabilityDeferral
			),
			unavailableReason: unavailableAgentReason(
				requested,
				allowSubagent,
				allowUnavailablePinReplacement,
				allowModelAvailabilityDeferral
			),
		}),
		...resolvedThinkingSelection,
	};
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

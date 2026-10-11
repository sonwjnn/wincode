import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	normalizeThinkingSelection,
	type ThinkingSelection,
} from "@wincode/ai/models";
import { buildAgent, type ResolvedCodingAgent } from "./built-ins";
import type { AgentRegistry } from "./registry";

export type AgentCallSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
} & ThinkingSelection;

export type PreparedAgentCall = AgentCallSelection & {
	readonly resolvedAgent: ResolvedCodingAgent;
};

export type EffectiveAgentSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
	readonly resolvedAgent?: ResolvedCodingAgent;
} & ThinkingSelection;

/** Composer-level choices that intentionally take precedence over Agent defaults. */
export type AgentSelectionOverride = Readonly<{
	model?: ChatModelSelection;
	thinking?: ThinkingSelection;
}>;

export const resolveEffectiveAgentSelection = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	fallbackModel: ChatModelSelection,
	fallbackSelection: ThinkingSelection,
	allowSubagent = false,
	selectionOverride?: AgentSelectionOverride
): EffectiveAgentSelection => {
	const candidates = allowSubagent
		? (registry?.agents ?? [])
		: (registry?.selectableAgents ?? []);
	const selected = candidates.find(
		(agent) => agent.id === agentId && agent.isAvailable
	);
	const fallbackAgent = candidates.find(
		(agent) => agent.id === "build" && agent.isAvailable
	);
	const effectiveAgent = selected ?? fallbackAgent;
	const effectiveAgentId =
		effectiveAgent?.id ?? (registry ? buildAgent.id : agentId);
	const model =
		selectionOverride?.model ?? effectiveAgent?.model ?? fallbackModel;
	const hasSelectionOverride =
		selectionOverride?.model !== undefined ||
		selectionOverride?.thinking !== undefined;
	const selectionUsesAgentModel =
		effectiveAgent?.model !== undefined &&
		(selectionOverride?.model === undefined ||
			(selectionOverride.model.modelId === effectiveAgent.model.modelId &&
				selectionOverride.model.providerId ===
					effectiveAgent.model.providerId));
	let thinkingSelection: ThinkingSelection;
	if (selectionOverride?.thinking !== undefined) {
		thinkingSelection = selectionOverride.thinking;
	} else if (!selectionUsesAgentModel) {
		thinkingSelection = fallbackSelection;
	} else if (effectiveAgent.thinkingLevel === undefined) {
		thinkingSelection = {};
	} else {
		thinkingSelection = { thinkingLevel: effectiveAgent.thinkingLevel };
	}
	const resolvedThinkingSelection = hasSelectionOverride
		? normalizeThinkingSelection(model, thinkingSelection)
		: thinkingSelection;
	return {
		agent: effectiveAgentId,
		model,
		...(effectiveAgent
			? {
					resolvedAgent: {
						id: effectiveAgent.id,
						instructions: effectiveAgent.instructions,
						role: effectiveAgent.role,
						visibleCodingTools: [...effectiveAgent.visibleCodingTools],
					},
				}
			: {}),
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

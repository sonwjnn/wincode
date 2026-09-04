import type { AgentId, ResolvedAgentRuntime } from "@wincode/ai";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { AgentRegistry } from "./registry";

export type AgentCallSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
	readonly variant?: ModelVariant;
};

export type PreparedAgentCall = AgentCallSelection & {
	readonly resolvedAgent: ResolvedAgentRuntime;
};

export type EffectiveAgentSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
	readonly resolvedAgent?: ResolvedAgentRuntime;
	readonly variant?: ModelVariant;
};

export const resolveEffectiveAgentSelection = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	fallbackModel: ChatModelSelection,
	fallbackVariant: ModelVariant | undefined,
	allowSubagent = false
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
	const effectiveAgentId = effectiveAgent?.id ?? (registry ? "build" : agentId);
	return {
		agent: effectiveAgentId,
		model: effectiveAgent?.model ?? fallbackModel,
		...(effectiveAgent
			? {
					resolvedAgent: {
						instructions: effectiveAgent.instructions,
						visibleCodingTools: [...effectiveAgent.visibleCodingTools],
					},
				}
			: {}),
		variant: effectiveAgent?.model ? effectiveAgent.variant : fallbackVariant,
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
		selection.variant,
		options?.allowSubagent ?? false
	);
	if (!effective.resolvedAgent) {
		throw new Error("No resolved Agent or model to send");
	}
	return {
		agent: effective.agent,
		model: effective.model,
		variant: effective.variant,
		resolvedAgent: effective.resolvedAgent,
	};
};

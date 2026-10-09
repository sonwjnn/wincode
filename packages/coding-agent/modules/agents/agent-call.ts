import type { AgentId } from "@wincode/agent-core";
import type { ChatModelSelection, ThinkingSelection } from "@wincode/ai/models";
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

export const resolveEffectiveAgentSelection = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	fallbackModel: ChatModelSelection,
	fallbackSelection: ThinkingSelection,
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
	const effectiveAgentId =
		effectiveAgent?.id ?? (registry ? buildAgent.id : agentId);
	const selectedThinking =
		effectiveAgent?.thinkingLevel === undefined
			? {}
			: { thinkingLevel: effectiveAgent.thinkingLevel };
	return {
		agent: effectiveAgentId,
		model: effectiveAgent?.model ?? fallbackModel,
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
		...(effectiveAgent?.model ? selectedThinking : fallbackSelection),
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

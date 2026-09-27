import type { AgentId } from "@wincode/agent-core";
import {
	type ChatModelSelection,
	createReasoningSelection,
	type ReasoningSelection,
} from "@wincode/ai/models";
import { buildAgent, type ResolvedCodingAgent } from "./built-ins";
import type { AgentRegistry } from "./registry";

export type AgentCallSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
} & ReasoningSelection;

export type PreparedAgentCall = AgentCallSelection & {
	readonly resolvedAgent: ResolvedCodingAgent;
};

export type EffectiveAgentSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
	readonly resolvedAgent?: ResolvedCodingAgent;
} & ReasoningSelection;

export const resolveEffectiveAgentSelection = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	fallbackModel: ChatModelSelection,
	fallbackSelection: ReasoningSelection,
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
	const selectedReasoning = createReasoningSelection(
		effectiveAgent?.effort,
		effectiveAgent?.reasoningMode
	);
	return {
		agent: effectiveAgentId,
		model: effectiveAgent?.model ?? fallbackModel,
		...(effectiveAgent
			? {
					resolvedAgent: {
						id: effectiveAgent.id,
						instructions: effectiveAgent.instructions,
						role: effectiveAgent.role,
						...(effectiveAgent.requiresManualApproval
							? { requiresManualApproval: true }
							: {}),
						visibleCodingTools: [...effectiveAgent.visibleCodingTools],
					},
				}
			: {}),
		...(effectiveAgent?.model ? selectedReasoning : fallbackSelection),
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
	const reasoningSelection = createReasoningSelection(
		effective.effort,
		effective.reasoningMode
	);
	return {
		agent: effective.agent,
		model: effective.model,
		...reasoningSelection,
		resolvedAgent: effective.resolvedAgent,
	};
};

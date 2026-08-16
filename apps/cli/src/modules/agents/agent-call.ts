import {
	type AgentBillingKind,
	type AgentId,
	type ChatModelSelection,
	getChatModelRoute,
	type HostedAgentDescriptor,
	type McpToolManifest,
	type ModelVariant,
	type ResolvedAgentRuntime,
} from "@wincode/ai";
import type { AgentRegistry } from "./registry";

/**
 * The Agent call-preparation seam. Everything that turns a selected Agent
 * into something an execution loop can run crosses this module:
 *
 * - the effective selection (availability-aware, falling back to Build),
 * - the `ResolvedAgentRuntime` descriptor — one builder, one shape, pinned
 *   to `resolvedAgentRuntimeSchema` in `@wincode/ai` (the schema of record),
 * - the hosted projection (ADR-0003's uniform hosted descriptor) with the
 *   CLI-only `shell` tool stripped (ADR-0005) and billing kind derived.
 *
 * Both transports and Tool Permission consume the same resolution, so the
 * registry is never built twice and the hosted/direct descriptors cannot
 * drift from each other.
 */

export type AgentCallSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
	readonly variant?: ModelVariant;
};

export type PreparedAgentCall = AgentCallSelection & {
	readonly resolvedAgent: ResolvedAgentRuntime;
	/** Present only when the effective model routes to the hosted runtime. */
	readonly hostedDescriptor?: HostedAgentDescriptor;
};

export type EffectiveAgentSelection = {
	readonly agent: AgentId;
	readonly model: ChatModelSelection;
	readonly resolvedAgent?: ResolvedAgentRuntime;
	readonly variant?: ModelVariant;
};

/** Resolve a restored selection first, or the configured default for new chats. */
export const resolveEffectiveAgentSelection = (
	registry: AgentRegistry | null,
	agentId: AgentId,
	fallbackModel: ChatModelSelection,
	fallbackVariant: ModelVariant | undefined
): EffectiveAgentSelection => {
	const selected = registry?.selectableAgents.find(
		(agent) => agent.id === agentId && agent.isAvailable
	);
	const fallbackAgent = registry?.selectableAgents.find(
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

const getBillingKind = (agent: AgentId): AgentBillingKind => {
	if (agent === "build" || agent === "plan") {
		return agent;
	}
	return "custom";
};

/**
 * Prepares one Agent call: resolves the effective selection, packs the
 * runtime descriptor, and — for hosted routes — projects the uniform hosted
 * descriptor. The hosted runtime never executes `shell` (ADR-0005), so the
 * CLI-only tool is stripped here, once, at the seam; the server rejects it
 * defensively too.
 */
export const prepareAgentCall = (
	registry: AgentRegistry | null,
	selection: AgentCallSelection,
	mcpTools?: McpToolManifest
): PreparedAgentCall => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		selection.agent,
		selection.model,
		selection.variant
	);
	if (!effective.resolvedAgent) {
		throw new Error("No resolved Agent or model to send");
	}
	return {
		agent: effective.agent,
		model: effective.model,
		variant: effective.variant,
		resolvedAgent: effective.resolvedAgent,
		...(getChatModelRoute(effective.model) === "hosted"
			? {
					hostedDescriptor: {
						billingKind: getBillingKind(effective.agent),
						instructions: effective.resolvedAgent.instructions,
						mcpTools: mcpTools ?? [],
						visibleCodingTools:
							effective.resolvedAgent.visibleCodingTools.filter(
								(tool) => tool !== "shell"
							),
					},
				}
			: {}),
	};
};

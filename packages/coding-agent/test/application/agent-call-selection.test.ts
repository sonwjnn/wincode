import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	type AgentRegistry,
	type RegistryAgent,
	resolveEffectiveAgentSelection,
	resolveInteractiveAgentSelection,
} from "@/modules/agents";
import type {
	PluginProviderOwnerRegistration,
	ProviderModelSelection,
} from "@/modules/providers/provider-model-selection";
import { DEFAULT_PROVIDER_MODEL_SELECTION } from "@/modules/providers/provider-model-selection";
import { agentId, modelId } from "../support/identifiers";

const pinnedModel: ProviderModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
const selectedModel: ProviderModelSelection = {
	modelId: modelId("gpt-6-luna"),
	providerId: "openai",
};
const pinnedAgentId = agentId("pinned-agent");
const pinnedAgent = fromPartial<RegistryAgent>({
	displayName: "Pinned Agent",
	id: pinnedAgentId,
	instructions: "Keep the pinned Agent identity.",
	isAvailable: true,
	isSelectable: true,
	model: pinnedModel,
	role: "all",
	thinkingLevel: "high",
	visibleCodingTools: ["read"],
});
const registry = fromPartial<AgentRegistry>({
	agents: [pinnedAgent],
	selectableAgents: [pinnedAgent],
});

test("Plugin selection controls override a pinned Agent for future submissions", () => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		pinnedAgentId,
		DEFAULT_PROVIDER_MODEL_SELECTION,
		{ thinkingLevel: "low" },
		false,
		{
			model: selectedModel,
			thinking: { thinkingLevel: "low" },
		}
	);

	expect(effective).toMatchObject({
		agent: pinnedAgentId,
		model: selectedModel,
		resolvedAgent: { instructions: "Keep the pinned Agent identity." },
		thinkingLevel: "low",
	});
});

test("an explicit provider-default choice overrides a pinned Agent ThinkingLevel", () => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		pinnedAgentId,
		DEFAULT_PROVIDER_MODEL_SELECTION,
		{ thinkingLevel: "low" },
		false,
		{ thinking: {} }
	);

	expect(effective).toMatchObject({ agent: pinnedAgentId, model: pinnedModel });
	expect(effective).not.toHaveProperty("thinkingLevel");
});

test("an unavailable Agent keeps its pinned model instead of using the composer fallback", () => {
	const unavailableAgent = fromPartial<RegistryAgent>({
		...pinnedAgent,
		isAvailable: false,
		isSelectable: false,
		unavailableReason: "Connect openai to use this Agent",
	});
	const unavailableRegistry = fromPartial<AgentRegistry>({
		agents: [unavailableAgent],
		selectableAgents: [],
	});

	const effective = resolveEffectiveAgentSelection(
		unavailableRegistry,
		pinnedAgentId,
		selectedModel,
		{},
		false
	);

	expect(effective).toMatchObject({
		agent: pinnedAgentId,
		model: pinnedModel,
		unavailableReason: "Connect openai to use this Agent",
	});
	expect(effective).not.toHaveProperty("resolvedAgent");
});

test("an explicit Provider Model replacement overrides an available Agent pin", () => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		pinnedAgentId,
		pinnedModel,
		{},
		false,
		{ model: selectedModel }
	);

	expect(effective).toMatchObject({
		agent: pinnedAgentId,
		model: selectedModel,
		resolvedAgent: {
			id: pinnedAgentId,
			instructions: "Keep the pinned Agent identity.",
			visibleCodingTools: ["read"],
		},
	});
	expect(effective).not.toHaveProperty("unavailableReason");
});

test("a replacement model does not bypass unrelated Agent restrictions", () => {
	const unavailableAgent = fromPartial<RegistryAgent>({
		...pinnedAgent,
		isAvailable: false,
		isSelectable: false,
		unavailableReason:
			"Connect openai to use this Agent; Missing required child tools: submit_result",
	});
	const unavailableRegistry = fromPartial<AgentRegistry>({
		agents: [unavailableAgent],
		selectableAgents: [],
	});

	const effective = resolveEffectiveAgentSelection(
		unavailableRegistry,
		pinnedAgentId,
		selectedModel,
		{},
		false,
		{ model: selectedModel }
	);

	expect(effective).toMatchObject({
		unavailableReason: expect.stringContaining("Missing required child tools"),
	});
	expect(effective).not.toHaveProperty("resolvedAgent");
});

const pluginPinnedModel: ProviderModelSelection = {
	modelId: modelId("agent-pinned-model"),
	providerId: "trusted-agent-provider",
};
const pluginPinnedAgentId = agentId("trusted-pinned-agent");
const pluginPinnedAgent = fromPartial<RegistryAgent>({
	displayName: "Trusted Pinned Agent",
	id: pluginPinnedAgentId,
	instructions: "Use its selected Provider Model.",
	isAvailable: true,
	isSelectable: true,
	model: pluginPinnedModel,
	role: "primary",
	visibleCodingTools: ["read"],
});
const pluginPinnedRegistry = fromPartial<AgentRegistry>({
	agents: [pluginPinnedAgent],
	selectableAgents: [pluginPinnedAgent],
});
const trustedPluginProvider: PluginProviderOwnerRegistration = {
	pluginId: "trusted-provider-plugin",
	providerId: pluginPinnedModel.providerId,
	sourceIdentity: "trusted-provider-source",
};

const resolvePluginPinnedSelection = (
	registrations: readonly PluginProviderOwnerRegistration[],
	restoredModel?: ProviderModelSelection
) =>
	resolveInteractiveAgentSelection(
		pluginPinnedRegistry,
		pluginPinnedAgentId,
		DEFAULT_PROVIDER_MODEL_SELECTION,
		{},
		undefined,
		registrations,
		restoredModel
	);

test("binds a fresh Interactive Agent pin to its unique trusted Plugin Provider before availability", () => {
	const effective = resolvePluginPinnedSelection([trustedPluginProvider]);

	expect(effective.model).toEqual({
		...pluginPinnedModel,
		pluginProviderSource: {
			pluginId: trustedPluginProvider.pluginId,
			sourceIdentity: trustedPluginProvider.sourceIdentity,
		},
	});
});

test("rejects ambiguous or untrusted Interactive Agent pins before availability", () => {
	expect(() => resolvePluginPinnedSelection([])).toThrow(
		"has no matching trusted source"
	);
	expect(() =>
		resolvePluginPinnedSelection([
			trustedPluginProvider,
			{ ...trustedPluginProvider, pluginId: "second-provider-plugin" },
		])
	).toThrow("has no matching trusted source");
});

test("keeps a matching restored owner and rejects a missing restored owner", () => {
	const restoredModel: ProviderModelSelection = {
		...pluginPinnedModel,
		pluginProviderSource: {
			pluginId: trustedPluginProvider.pluginId,
			sourceIdentity: trustedPluginProvider.sourceIdentity,
		},
	};

	expect(
		resolvePluginPinnedSelection([trustedPluginProvider], restoredModel).model
	).toEqual(restoredModel);
	expect(() =>
		resolvePluginPinnedSelection([trustedPluginProvider], pluginPinnedModel)
	).toThrow("has no matching trusted source");
});

test("reselecting the pinned model keeps its Agent ThinkingLevel", () => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		pinnedAgentId,
		DEFAULT_PROVIDER_MODEL_SELECTION,
		{ thinkingLevel: "low" },
		false,
		{ model: pinnedModel }
	);

	expect(effective).toMatchObject({
		model: pinnedModel,
		thinkingLevel: "high",
	});
});

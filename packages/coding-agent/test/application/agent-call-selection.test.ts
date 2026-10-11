import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import {
	type ChatModelSelection,
	defaultChatModelSelection,
} from "@wincode/ai/models";
import {
	type AgentRegistry,
	type RegistryAgent,
	resolveEffectiveAgentSelection,
} from "@/modules/agents";
import { agentId, modelId } from "../support/identifiers";

const pinnedModel: ChatModelSelection = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
};
const selectedModel: ChatModelSelection = {
	modelId: modelId("gpt-6-luna"),
	providerId: "openai",
};
const pinnedAgentId = agentId("pinned-agent");
const pinnedAgent = fromPartial<RegistryAgent>({
	id: pinnedAgentId,
	instructions: "Keep the pinned Agent identity.",
	isAvailable: true,
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
		defaultChatModelSelection,
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
		defaultChatModelSelection,
		{ thinkingLevel: "low" },
		false,
		{ thinking: {} }
	);

	expect(effective).toMatchObject({ agent: pinnedAgentId, model: pinnedModel });
	expect(effective).not.toHaveProperty("thinkingLevel");
});

test("reselecting the pinned model keeps its Agent ThinkingLevel", () => {
	const effective = resolveEffectiveAgentSelection(
		registry,
		pinnedAgentId,
		defaultChatModelSelection,
		{ thinkingLevel: "low" },
		false,
		{ model: pinnedModel }
	);

	expect(effective).toMatchObject({
		model: pinnedModel,
		thinkingLevel: "high",
	});
});

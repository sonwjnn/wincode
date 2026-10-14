import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentDefinition } from "@wincode/agent-core";
import { defaultChatModelSelection } from "@wincode/ai/models";
import type { ProviderModel } from "@wincode/ai/sdk";
import {
	canReplaceUnavailableAgentModel,
	getAgentUnavailableReason,
} from "@/modules/prompt-settings/ui/agents-dialog";
import {
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";

const agentFor = (model: ProviderModelSelection, isAvailable = true) =>
	fromPartial<
		AgentDefinition & {
			readonly isAvailable: boolean;
			readonly model: ProviderModelSelection;
			readonly modelUnavailableReason?: string;
			readonly unavailableReason?: string;
		}
	>({
		displayName: "Pinned Agent",
		isAvailable,
		model,
		modelUnavailableReason: "Legacy connection is unavailable",
		unavailableReason: "Legacy connection is unavailable",
	});

const sdkSelection = parseProviderModelSelection("plugin-provider/exact-model");
if (sdkSelection === null) {
	throw new Error("The fake Provider Model selection was invalid.");
}

const currentSdkModel: ProviderModel = {
	modelId: sdkSelection.modelId,
	protocolId: "fixture",
	providerId: sdkSelection.providerId,
};

test("SDK Agent pins use exact current ProviderCollection models, not Connections IDs", () => {
	const agent = agentFor(sdkSelection);

	expect(
		getAgentUnavailableReason(agent, new Set([sdkSelection.providerId]), [])
	).toContain("Provider Model plugin-provider/exact-model is unavailable");
	expect(
		getAgentUnavailableReason(agentFor(sdkSelection, false), new Set(), [
			currentSdkModel,
		])
	).toBeUndefined();
});

test("a current Provider Model overrides a stale legacy Agent pin connection", () => {
	const catalogSelection = defaultChatModelSelection;
	const currentModel: ProviderModel = {
		modelId: catalogSelection.modelId,
		protocolId: "fixture",
		providerId: catalogSelection.providerId,
	};
	const pinnedAgent = agentFor(catalogSelection, false);

	expect(
		getAgentUnavailableReason(pinnedAgent, new Set(), [currentModel])
	).toBeUndefined();
});

test("an unavailable pin with an unrelated Agent restriction cannot be replaced", () => {
	const agent = {
		...agentFor(defaultChatModelSelection, false),
		modelUnavailableReason: "Provider Model openai/gpt-5.6-luna is unavailable",
		unavailableReason:
			"Provider Model openai/gpt-5.6-luna is unavailable; Missing required child tools: shell",
	};

	expect(canReplaceUnavailableAgentModel(agent, [currentSdkModel])).toBe(false);
});

test("legacy connectivity checks apply only to Catalog selections", () => {
	const sdkAgent = agentFor(sdkSelection);
	const catalogAgent = agentFor(defaultChatModelSelection);

	expect(
		getAgentUnavailableReason(sdkAgent, new Set([sdkSelection.providerId]))
	).toContain("requires the Provider SDK runtime");
	expect(
		getAgentUnavailableReason(
			catalogAgent,
			new Set([defaultChatModelSelection.providerId])
		)
	).toBeUndefined();
	expect(
		getAgentUnavailableReason(catalogAgent, new Set(), [currentSdkModel])
	).toContain(`Provider Model ${defaultChatModelSelection.providerId}/`);
});

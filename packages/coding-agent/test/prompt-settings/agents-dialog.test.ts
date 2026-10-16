import { expect, test } from "bun:test";
import { fromPartial } from "@total-typescript/shoehorn";
import type { AgentDefinition } from "@wincode/agent-core";
import type { ProviderModel } from "@wincode/ai/sdk";
import {
	canReplaceUnavailableAgentModel,
	getAgentUnavailableReason,
} from "@/modules/prompt-settings/ui/agents-dialog";
import {
	type ProviderModelSelection,
	parseProviderModelSelection,
} from "@/modules/providers/provider-model-selection";

const agentFor = (
	model: ProviderModelSelection,
	isAvailable = true,
	unavailableReason?: string
) =>
	fromPartial<
		AgentDefinition & {
			readonly isAvailable: boolean;
			readonly model: ProviderModelSelection;
			readonly unavailableReason?: string;
		}
	>({
		displayName: "Pinned Agent",
		isAvailable,
		model,
		...(unavailableReason === undefined ? {} : { unavailableReason }),
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

test("pinned Agent availability requires an exact current Provider Model", () => {
	const agent = agentFor(sdkSelection);

	expect(getAgentUnavailableReason(agent, [])).toContain(
		"Provider Model plugin-provider/exact-model is unavailable"
	);
	expect(getAgentUnavailableReason(agent, [currentSdkModel])).toBeUndefined();
});

test("a pinned Agent fails closed when Provider Models cannot be checked", () => {
	expect(getAgentUnavailableReason(agentFor(sdkSelection))).toContain(
		"availability cannot be checked"
	);
});

test("an unrelated Agent restriction prevents replacement of a missing pinned model", () => {
	const agent = agentFor(
		sdkSelection,
		false,
		"Missing required child tools: shell"
	);

	expect(canReplaceUnavailableAgentModel(agent, [])).toBe(false);
	expect(getAgentUnavailableReason(agent, [currentSdkModel])).toBe(
		"Missing required child tools: shell"
	);
});

test("a missing pinned model can only be replaced by an explicit available choice", () => {
	const replacement: ProviderModel = {
		modelId: "replacement-model",
		protocolId: "fixture",
		providerId: "plugin-provider",
	};
	const agent = agentFor(sdkSelection);

	expect(canReplaceUnavailableAgentModel(agent, [replacement])).toBe(true);
	expect(canReplaceUnavailableAgentModel(agent, [currentSdkModel])).toBe(false);
});

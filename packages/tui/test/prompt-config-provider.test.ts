import { describe, expect, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai/models";
import { updatePromptConfigModel } from "@/modules/prompt-settings/context/prompt-config-provider";
import { agentId, modelId } from "./support/identifiers";

const model = (
	id: string,
	providerId: ChatModelSelection["providerId"]
): ChatModelSelection => ({
	modelId: modelId(id),
	providerId,
});

describe("updatePromptConfigModel", () => {
	test("keeps variant when model provider and id stay same", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("gpt-5.5", "openai"),
					variant: "high",
				},
				model("gpt-5.5", "openai")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("gpt-5.5", "openai"),
			variant: "high",
		});
	});

	test("resets variant when model provider changes", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("gpt-5.5", "openai"),
					variant: "high",
				},
				model("claude-sonnet-5", "anthropic")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("claude-sonnet-5", "anthropic"),
			variant: undefined,
		});
	});

	test("resets variant when model id changes within same provider", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: agentId("code-reviewer"),
					model: model("gpt-5.5", "openai"),
					variant: "high",
				},
				model("gpt-5.6", "openai")
			)
		).toEqual({
			agent: agentId("code-reviewer"),
			model: model("gpt-5.6", "openai"),
			variant: undefined,
		});
	});
});

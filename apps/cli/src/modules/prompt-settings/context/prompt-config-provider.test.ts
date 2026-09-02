import { describe, expect, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai/models";
import { updatePromptConfigModel } from "./prompt-config-provider";

const model = (
	modelId: string,
	providerId: ChatModelSelection["providerId"]
): ChatModelSelection => ({
	modelId,
	providerId,
});

describe("updatePromptConfigModel", () => {
	test("keeps variant when model provider and id stay same", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: "code-reviewer",
					model: model("gpt-5.5", "openai"),
					variant: "high",
				},
				model("gpt-5.5", "openai")
			)
		).toEqual({
			agent: "code-reviewer",
			model: model("gpt-5.5", "openai"),
			variant: "high",
		});
	});

	test("resets variant when model provider changes", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: "code-reviewer",
					model: model("gpt-5.5", "openai"),
					variant: "high",
				},
				model("claude-sonnet-5", "anthropic")
			)
		).toEqual({
			agent: "code-reviewer",
			model: model("claude-sonnet-5", "anthropic"),
			variant: undefined,
		});
	});

	test("resets variant when model id changes within same provider", () => {
		expect(
			updatePromptConfigModel(
				{
					agent: "code-reviewer",
					model: model("gpt-5.5", "openai"),
					variant: "high",
				},
				model("gpt-5.6", "openai")
			)
		).toEqual({
			agent: "code-reviewer",
			model: model("gpt-5.6", "openai"),
			variant: undefined,
		});
	});
});

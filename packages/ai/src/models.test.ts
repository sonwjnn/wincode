import { describe, expect, test } from "bun:test";
import {
	chatModelSelectionSchemaWithValidation,
	defaultChatModelSelection,
	findSupportedChatModelSelection,
	isSupportedChatModelSelection,
	normalizeChatModelSelection,
} from "./models";

describe("shared chat model selection", () => {
	test("default selection targets wincode gpt-5.4-mini", () => {
		expect(defaultChatModelSelection).toEqual({
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		});
	});

	test("accepts duplicate model id across providers only for valid pairs", () => {
		expect(
			findSupportedChatModelSelection({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toMatchObject({
			connectionProviderId: "wincode",
			id: "gpt-5.4-mini",
		});
		expect(
			findSupportedChatModelSelection({
				modelId: "gpt-5.4-mini",
				providerId: "openai",
			})
		).toMatchObject({
			connectionProviderId: "openai",
			id: "gpt-5.4-mini",
		});
		expect(
			chatModelSelectionSchemaWithValidation.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toMatchObject({ success: true });
		expect(
			chatModelSelectionSchemaWithValidation.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toMatchObject({ success: false });
		expect(
			isSupportedChatModelSelection({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toBe(true);
	});

	test("rejects invalid model/provider pairs", () => {
		expect(
			chatModelSelectionSchemaWithValidation.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toMatchObject({ success: false });
	});

	test("normalizes legacy ids to host selections", () => {
		expect(normalizeChatModelSelection("gemini-3.5-flash")).toEqual({
			modelId: "gemini-2.5-flash",
			providerId: "wincode",
		});
		expect(normalizeChatModelSelection("claude-3.5-sonnet")).toBeNull();
		expect(normalizeChatModelSelection("unknown-model")).toBeNull();
	});
});

import { describe, expect, test } from "bun:test";
import {
	chatModelSelectionSchema,
	defaultChatModelSelection,
	findSupportedChatModelSelection,
	getSupportedModelVariants,
	isSupportedChatModelSelection,
	normalizeChatModelSelection,
	normalizeModelVariant,
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
				modelId: "gpt-5.5",
				providerId: "openai",
			})
		).toMatchObject({
			connectionProviderId: "openai",
			id: "gpt-5.5",
		});
		expect(
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "wincode",
			})
		).toMatchObject({ success: true });
		expect(
			chatModelSelectionSchema.safeParse({
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
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
				providerId: "anthropic",
			})
		).toMatchObject({ success: false });
		expect(
			chatModelSelectionSchema.safeParse({
				modelId: "gpt-5.4-mini",
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

	test("resolves supported variants for selections", () => {
		expect(
			getSupportedModelVariants({
				modelId: "claude-sonnet-5",
				providerId: "anthropic",
			})
		).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(
			normalizeModelVariant(
				{ modelId: "gemma-4-31b-it", providerId: "google" },
				"high"
			)
		).toBeUndefined();
		expect(
			normalizeModelVariant(
				{ modelId: "gpt-5.6", providerId: "openai" },
				"none"
			)
		).toBe("none");
	});
});

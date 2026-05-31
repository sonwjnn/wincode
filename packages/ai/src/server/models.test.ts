import { describe, expect, test } from "bun:test";
import {
	isSupportedChatModel,
	resolveChatModel,
	resolveSupportedChatModel,
} from "@wincode/ai/server";

describe("server chat model resolver", () => {
	test("reports supported chat models", () => {
		expect(isSupportedChatModel("claude-sonnet-4.6")).toBe(true);
		expect(isSupportedChatModel("gemini-3.5-flash")).toBe(true);
		expect(isSupportedChatModel("gpt-5.4-mini")).toBe(true);
		expect(isSupportedChatModel("unknown-model")).toBe(false);
	});

	test("resolves provider-specific models and provider options", () => {
		expect(resolveChatModel("claude-sonnet-4.6")).toMatchObject({
			modelId: "claude-sonnet-4.6",
			provider: "anthropic",
			providerOptions: {
				anthropic: {
					thinking: {
						budgetTokens: 10_000,
						type: "enabled",
					},
				},
			},
		});
		expect(resolveChatModel("gemini-3.5-flash")).toMatchObject({
			modelId: "gemini-3.5-flash",
			provider: "google",
			providerOptions: {
				google: {
					thinkingConfig: {
						includeThoughts: true,
					},
				},
			},
		});
		expect(resolveChatModel("gpt-5.4-mini")).toMatchObject({
			modelId: "gpt-5.4-mini",
			provider: "openai",
			providerOptions: {
				openai: {
					reasoningSummary: "detailed",
				},
			},
		});
	});

	test("rejects unsupported model ids", () => {
		expect(() => resolveChatModel("unknown-model")).toThrow(
			"Unsupported model: unknown-model"
		);
		expect(() =>
			resolveSupportedChatModel({ id: "fake", provider: "fake" } as never)
		).toThrow("Unsupported provider: fake");
	});
});

import { describe, expect, test } from "bun:test";
import {
	isSupportedChatModel,
	resolveChatModel,
	resolveDirectChatModel,
	resolveSupportedChatModel,
	resolveWincodeChatModelSelection,
} from "@wincode/ai/server";
import { resolveHostChatModelSelection } from "./models";

describe("server chat model resolver", () => {
	test("reports supported chat models", () => {
		expect(isSupportedChatModel("claude-sonnet-5")).toBe(true);
		expect(isSupportedChatModel("gemini-2.5-flash")).toBe(true);
		expect(isSupportedChatModel("gpt-5.4-mini")).toBe(true);
		expect(isSupportedChatModel("unknown-model")).toBe(false);
	});

	test("resolves provider-specific models and provider options", () => {
		expect(resolveChatModel("claude-sonnet-5")).toMatchObject({
			modelId: "claude-sonnet-5",
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
		expect(resolveChatModel("gemini-2.5-flash")).toMatchObject({
			modelId: "gemini-2.5-flash",
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
					store: false,
				},
			},
		});
	});

	test("resolves host wincode catalog entries only", () => {
		expect(resolveWincodeChatModelSelection("gpt-5.4-mini")).toMatchObject({
			connectionProviderId: "wincode",
			id: "gpt-5.4-mini",
		});
		expect(() => resolveWincodeChatModelSelection("gpt-5.5")).toThrow(
			"Unsupported host model: gpt-5.5"
		);
	});

	test("resolves direct provider models with api keys", () => {
		expect(
			resolveDirectChatModel(
				{ modelId: "gpt-5.5", providerId: "openai" },
				"sk-test"
			)
		).toMatchObject({ modelId: "gpt-5.5", provider: "openai" });
	});

	test("rejects unsupported model ids", () => {
		expect(() => resolveChatModel("unknown-model")).toThrow(
			"Unsupported model: unknown-model"
		);
		expect(() => resolveHostChatModelSelection("claude-sonnet-5")).toThrow(
			"Unsupported host model: claude-sonnet-5"
		);
		expect(() =>
			resolveSupportedChatModel({ id: "fake", provider: "fake" } as never)
		).toThrow("Unsupported provider: fake");
	});
});

import { describe, expect, test } from "bun:test";
import {
	isSupportedChatModel,
	resolveChatModel,
	resolveDirectChatModel,
	resolveHostChatModelSelection,
	resolveOpenAIChatModel,
	resolveSupportedChatModel,
	resolveWincodeChatModelSelection,
} from "./models";

describe("server chat model resolver", () => {
	test("reports supported chat models", () => {
		expect(isSupportedChatModel("claude-sonnet-5")).toBe(true);
		expect(isSupportedChatModel("gemini-2.5-flash")).toBe(true);
		expect(isSupportedChatModel("gpt-5.4-mini")).toBe(true);
		expect(isSupportedChatModel("unknown-model")).toBe(false);
	});

	test("resolves provider-specific models and provider options", () => {
		const anthropicCases = [
			[
				"claude-opus-4-5",
				{ variant: "high" as const },
				{
					anthropic: {
						effort: "high",
						thinking: { type: "enabled", budgetTokens: 16_000 },
					},
				},
			],
			[
				"claude-opus-4-5-20251101",
				{ variant: "low" as const },
				{
					anthropic: {
						effort: "low",
						thinking: { type: "enabled", budgetTokens: 16_000 },
					},
				},
			],
			[
				"claude-opus-4-6",
				{ variant: "medium" as const },
				{ anthropic: { effort: "medium", thinking: { type: "adaptive" } } },
			],
			[
				"claude-sonnet-4-6",
				{ variant: "high" as const },
				{ anthropic: { effort: "high", thinking: { type: "adaptive" } } },
			],
		] as const;
		for (const [modelId, options, providerOptions] of anthropicCases) {
			expect(
				resolveDirectChatModel(
					{ modelId, providerId: "anthropic" },
					"sk-test",
					options
				)
			).toMatchObject({ modelId, provider: "anthropic", providerOptions });
		}

		expect(resolveChatModel("claude-sonnet-5")).toMatchObject({
			modelId: "claude-sonnet-5",
			provider: "anthropic",
		});
		expect(
			resolveDirectChatModel(
				{ modelId: "gemini-2.5-flash", providerId: "google" },
				"sk-test",
				{ variant: "high" }
			)
		).toMatchObject({
			modelId: "gemini-2.5-flash",
			provider: "google",
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 12_288 } },
			},
		});
		expect(
			resolveDirectChatModel(
				{ modelId: "claude-sonnet-4-5", providerId: "anthropic" },
				"sk-test",
				{ variant: "high" }
			)
		).toMatchObject({
			modelId: "claude-sonnet-4-5",
			provider: "anthropic",
			maxOutputTokens: 32_000,
			providerOptions: {
				anthropic: { thinking: { type: "enabled", budgetTokens: 16_000 } },
			},
		});
		expect(resolveChatModel("gpt-5.4-mini")).toMatchObject({
			modelId: "gpt-5.4-mini",
			provider: "openai",
			providerOptions: {
				openai: { reasoningSummary: "detailed", store: false },
			},
		});
		expect(resolveChatModel("gpt-5.6")).toMatchObject({
			providerOptions: { openai: { store: false } },
		});
		expect(
			resolveDirectChatModel(
				{ modelId: "gpt-5.4-mini", providerId: "openai" },
				"sk-test",
				{ variant: "high" }
			)
		).toMatchObject({
			providerOptions: {
				openai: {
					reasoningSummary: "detailed",
					reasoningEffort: "high",
					store: false,
				},
			},
		});
		expect(
			resolveSupportedChatModel(
				{ id: "gpt-5.4-mini", provider: "openai" } as never,
				{ variant: "high" }
			)
		).toMatchObject({
			providerOptions: {
				openai: {
					reasoningSummary: "detailed",
					reasoningEffort: "high",
					store: false,
				},
			},
		});
		expect(
			resolveOpenAIChatModel(
				"gpt-5.4-mini",
				{ accessToken: "tok", accountId: "acct", originator: "win" },
				{ variant: "high" }
			)
		).toMatchObject({
			providerOptions: {
				openai: {
					reasoningSummary: "detailed",
					reasoningEffort: "high",
					store: false,
				},
			},
		});
		expect(
			resolveDirectChatModel(
				{ modelId: "gpt-5.6", providerId: "openai" },
				"sk-test",
				{ variant: "low" }
			)
		).toMatchObject({
			providerOptions: { openai: { reasoningEffort: "low" } },
		});
		expect(() =>
			resolveDirectChatModel(
				{ modelId: "gpt-5-pro", providerId: "openai" },
				"sk-test",
				{ variant: "low" }
			)
		).toThrow("Unsupported model variant: openai/gpt-5-pro/low");
		expect(() =>
			resolveOpenAIChatModel(
				"gpt-5-pro",
				{ accessToken: "tok" },
				{ variant: "low" }
			)
		).toThrow("Unsupported model variant: openai/gpt-5-pro/low");
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
		).toThrow("Unsupported provider");
	});
});

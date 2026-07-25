import { describe, expect, test } from "bun:test";
import { findSupportedChatModel, modelRuntimeProviderIds } from "../models";
import {
	isSupportedChatModel,
	resolveChatModel,
	resolveDirectChatModel,
	resolveHostChatModelSelection,
	resolveOpenAIChatModel,
	resolveSupportedChatModel,
	resolveWincodeChatModelSelection,
} from "./models";
import { modelResolverByProvider } from "./providers/registry";

describe("server chat model resolver", () => {
	test("reports supported chat models", () => {
		expect(isSupportedChatModel("claude-sonnet-5")).toBe(true);
		expect(isSupportedChatModel("gemini-2.5-flash")).toBe(true);
		expect(isSupportedChatModel("gpt-5.4-mini")).toBe(true);
		expect(isSupportedChatModel("unknown-model")).toBe(false);
	});

	test("resolves provider-specific models and provider options", () => {
		const actualModel = (modelId: string) => {
			const model = findSupportedChatModel(modelId);
			if (!model) {
				throw new Error(`Missing catalog model: ${modelId}`);
			}
			return model;
		};

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
				{ variant: "high" as const },
				{
					anthropic: {
						effort: "high",
						thinking: { type: "enabled", budgetTokens: 16_000 },
					},
				},
			],
			[
				"claude-opus-4-6",
				{ variant: "high" as const },
				{ anthropic: { effort: "high", thinking: { type: "adaptive" } } },
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
					{ modelId, providerId: actualModel(modelId).connectionProviderId },
					"sk-test",
					options
				)
			).toMatchObject({ modelId, provider: "anthropic", providerOptions });
		}

		const policyCases = [
			[
				"gpt-5.4-mini",
				"openai",
				{ variant: "high" as const },
				{
					openai: {
						reasoningSummary: "detailed",
						reasoningEffort: "high",
						store: false,
					},
				},
			],
			[
				"gpt-5.5",
				"openai",
				{ variant: "high" as const },
				{ openai: { reasoningSummary: "detailed", store: false } },
			],
			[
				"claude-sonnet-4-6",
				"anthropic",
				{ variant: "high" as const },
				{ anthropic: { effort: "high", thinking: { type: "adaptive" } } },
			],
			[
				"claude-opus-4-5",
				"anthropic",
				{ variant: "high" as const },
				{
					anthropic: {
						effort: "high",
						thinking: { type: "enabled", budgetTokens: 16_000 },
					},
				},
			],
			[
				"gemini-3.5-flash",
				"google",
				{ variant: "high" as const },
				{ google: { thinkingConfig: { thinkingLevel: "high" } } },
			],
			[
				"gemini-2.5-flash",
				"google",
				{ variant: "high" as const, maxOutputTokens: 20_000 },
				{ google: { thinkingConfig: { thinkingBudget: 12_288 } } },
			],
		] as const;
		for (const [modelId, providerId, options, providerOptions] of policyCases) {
			expect(
				resolveSupportedChatModel(actualModel(modelId), options)
			).toMatchObject({ modelId, provider: providerId, providerOptions });
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
			maxOutputTokens: 32_000,
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 12_288 } },
			},
		});
		expect(
			resolveSupportedChatModel(actualModel("gemini-2.5-flash"), {
				variant: "high",
				maxOutputTokens: 20_000,
			})
		).toMatchObject({
			maxOutputTokens: 20_000,
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
				{ modelId: "gpt-5.6", providerId: "openai" },
				"sk-test",
				{ variant: "high" }
			)
		).toMatchObject({
			providerOptions: { openai: { reasoningEffort: "high", store: false } },
		});
		expect(() =>
			resolveSupportedChatModel(actualModel("gemini-2.5-flash"), {
				variant: "high",
				maxOutputTokens: 12_288,
			})
		).toThrow(
			"Invalid Google budget for gemini-2.5-flash: 12288 must be less than 12288"
		);
		expect(() =>
			resolveSupportedChatModel(actualModel("claude-sonnet-4-5"), {
				variant: "high",
				maxOutputTokens: 16_000,
			})
		).toThrow(
			"Invalid Anthropic budget for claude-sonnet-4-5: 16000 must be less than 16000"
		);
		expect(
			resolveSupportedChatModel(actualModel("gpt-5.4-mini"), {
				variant: "high",
			})
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
				{ variant: "high" }
			)
		).toMatchObject({
			providerOptions: { openai: { reasoningEffort: "high" } },
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

	test("characterizes every special policy model", () => {
		const actualModel = (modelId: string) => {
			const model = findSupportedChatModel(modelId);
			if (!model) {
				throw new Error(`Missing catalog model: ${modelId}`);
			}
			return model;
		};
		const openAiDetailedSummaryIds = [
			"gpt-5.4-mini",
			"gpt-5.5",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		];
		for (const modelId of openAiDetailedSummaryIds) {
			expect(resolveSupportedChatModel(actualModel(modelId))).toMatchObject({
				modelId,
				providerOptions: {
					openai: { reasoningSummary: "detailed", store: false },
				},
			});
		}

		const anthropicAdaptiveIds = [
			"claude-opus-4-7",
			"claude-sonnet-5",
			"claude-opus-4-8",
			"claude-fable-5",
			"claude-opus-4-6",
			"claude-sonnet-4-6",
		];
		for (const modelId of anthropicAdaptiveIds) {
			expect(
				resolveDirectChatModel(
					{ modelId, providerId: "anthropic" },
					"sk-test",
					{ variant: "high" }
				)
			).toMatchObject({
				modelId,
				providerOptions: {
					anthropic: { effort: "high", thinking: { type: "adaptive" } },
				},
			});
		}

		const anthropicManualCases = [
			["claude-opus-4-5", 16_000],
			["claude-opus-4-5-20251101", 16_000],
		] as const;
		for (const [modelId, budgetTokens] of anthropicManualCases) {
			const resolved = resolveDirectChatModel(
				{ modelId, providerId: "anthropic" },
				"sk-test",
				{ variant: "high", maxOutputTokens: 40_000 }
			);
			expect(resolved).toMatchObject({
				providerOptions: {
					anthropic: {
						thinking: { type: "enabled", budgetTokens },
					},
				},
				maxOutputTokens: 32_000,
			});
		}

		const anthropicBudgetCases = [
			["claude-haiku-4-5", 16_000],
			["claude-haiku-4-5-20251001", 16_000],
			["claude-sonnet-4-5", 16_000],
			["claude-sonnet-4-5-20250929", 16_000],
		] as const;
		for (const [modelId, budgetTokens] of anthropicBudgetCases) {
			expect(
				resolveDirectChatModel(
					{ modelId, providerId: "anthropic" },
					"sk-test",
					{ variant: "high", maxOutputTokens: 40_000 }
				)
			).toMatchObject({
				providerOptions: {
					anthropic: { thinking: { type: "enabled", budgetTokens } },
				},
				maxOutputTokens: 32_000,
			});
		}

		for (const [modelId] of anthropicBudgetCases) {
			expect(
				resolveDirectChatModel(
					{ modelId, providerId: "anthropic" },
					"sk-test",
					{ variant: "max" }
				)
			).toMatchObject({
				providerOptions: { anthropic: { thinking: { budgetTokens: 31_999 } } },
			});
			expect(() =>
				resolveDirectChatModel(
					{ modelId, providerId: "anthropic" },
					"sk-test",
					{ variant: "max", maxOutputTokens: 31_999 }
				)
			).toThrow(
				`Invalid Anthropic budget for ${modelId}: 31999 must be less than 31999`
			);
		}

		const googleLevelIds = [
			"gemini-3.1-flash-lite",
			"gemini-3.5-flash",
			"gemini-3-flash-preview",
			"gemini-3.1-pro-preview",
			"gemini-3-pro-preview",
		];
		for (const modelId of googleLevelIds) {
			expect(
				resolveDirectChatModel({ modelId, providerId: "google" }, "sk-test", {
					variant: "high",
					maxOutputTokens: 40_000,
				})
			).toMatchObject({
				providerOptions: {
					google: { thinkingConfig: { thinkingLevel: "high" } },
				},
				maxOutputTokens: 32_000,
			});
		}

		const googleBudgetCases = [
			["gemini-2.5-pro", 16_000],
			["gemini-2.5-flash", 12_288],
			["gemini-flash-latest", 12_288],
			["gemini-flash-lite-latest", 12_288],
			["gemini-2.5-flash-lite", 12_288],
		] as const;
		for (const [modelId, budgetTokens] of googleBudgetCases) {
			expect(
				resolveDirectChatModel({ modelId, providerId: "google" }, "sk-test", {
					variant: "high",
					maxOutputTokens: 40_000,
				})
			).toMatchObject({
				providerOptions: {
					google: { thinkingConfig: { thinkingBudget: budgetTokens } },
				},
				maxOutputTokens: 32_000,
			});
		}
		for (const [modelId, budgetTokens] of googleBudgetCases) {
			const selectedMaxBudget = Math.min(31_999, budgetTokens * 2);
			expect(
				resolveDirectChatModel({ modelId, providerId: "google" }, "sk-test", {
					variant: "max",
				})
			).toMatchObject({
				providerOptions: {
					google: { thinkingConfig: { thinkingBudget: selectedMaxBudget } },
				},
			});
			expect(() =>
				resolveDirectChatModel({ modelId, providerId: "google" }, "sk-test", {
					variant: "max",
					maxOutputTokens: selectedMaxBudget,
				})
			).toThrow(
				`Invalid Google budget for ${modelId}: ${selectedMaxBudget} must be less than ${selectedMaxBudget}`
			);
		}
	});

	test("preserves OpenAI OAuth model and options", () => {
		const resolved = resolveOpenAIChatModel(
			"gpt-5.5",
			{ accessToken: "oauth-token", accountId: "account-id" },
			{ variant: "high" }
		);
		expect(resolved).toMatchObject({
			modelId: "gpt-5.5",
			provider: "openai",
			providerOptions: { openai: { reasoningEffort: "high", store: false } },
		});
		expect(resolved.model).toBeDefined();
	});

	test("rejects malformed runtime provider invocation", () => {
		const malformedModel = JSON.parse('{"id":"bad","provider":"bogus"}');
		expect(() =>
			Reflect.apply(resolveSupportedChatModel, null, [malformedModel])
		).toThrow("Unsupported provider");
	});

	test("keeps runtime provider registry aligned", () => {
		expect(Object.keys(modelResolverByProvider).sort()).toEqual(
			[...modelRuntimeProviderIds].sort()
		);
		for (const providerId of modelRuntimeProviderIds) {
			expect(modelResolverByProvider[providerId].provider).toBe(providerId);
		}
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

	test("validates hosted variants against catalog connection provider", () => {
		const hostedModel = resolveWincodeChatModelSelection("gemini-2.5-flash");

		expect(
			resolveSupportedChatModel(hostedModel, { variant: "max" })
		).toMatchObject({
			modelId: hostedModel.id,
			provider: "google",
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 24_576 } },
			},
		});
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
			resolveDirectChatModel(
				{ modelId: "gpt-5.4-mini", providerId: "wincode" },
				"sk-test"
			)
		).toThrow("Chat model selection is not direct: wincode/gpt-5.4-mini");
	});
});

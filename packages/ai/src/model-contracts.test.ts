import { describe, expect, test } from "bun:test";
import type {
	ChatModelSelection,
	ConnectionProviderId,
	SupportedChatModel,
} from "./model";
import {
	calculateModelUsageCostUsd,
	connectionProviderIds,
	createModelTarget,
	findSupportedChatModelSelection,
	formatModelTokenCount,
	getModelContextTokens,
	getSupportedModelVariants,
	modelCatalog,
	modelFailureSchema,
	modelSelectionSchema,
	modelTargetSchema,
	normalizeModelFailure,
	normalizeModelUsage,
	resolveModelProviderOptions,
} from "./model";

const findModel = (
	providerId: ConnectionProviderId,
	modelId: string
): SupportedChatModel => {
	const model = modelCatalog.find(
		(entry) => entry.connectionProviderId === providerId && entry.id === modelId
	);
	if (!model) {
		throw new Error(`Missing test model: ${providerId}/${modelId}`);
	}
	return model;
};

describe("focused model contracts", () => {
	test("catalogs every connection provider with unique selection pairs", () => {
		const providers = [
			...new Set(modelCatalog.map((model) => model.connectionProviderId)),
		].sort();
		expect(providers).toEqual([...connectionProviderIds].sort());

		const pairs = modelCatalog.map(
			(model) => `${model.connectionProviderId}/${model.id}`
		);
		expect(new Set(pairs).size).toBe(pairs.length);
	});

	test("validates model selections through the focused schema", () => {
		const selection: ChatModelSelection = {
			modelId: "gpt-5.4-mini",
			providerId: "openai",
		};
		expect(modelSelectionSchema.parse(selection)).toEqual(selection);
		expect(
			modelSelectionSchema.safeParse({
				modelId: "claude-opus-4-6",
				providerId: "openai",
			}).success
		).toBe(false);
		expect(findSupportedChatModelSelection(selection)?.id).toBe("gpt-5.4-mini");
	});

	test("creates a transient target with minimal authorization", () => {
		const target = createModelTarget(
			{ modelId: "gpt-5.4-mini", providerId: "openai" },
			{ apiKey: "secret", kind: "api-key" }
		);
		expect(Object.keys(target).sort()).toEqual([
			"authorization",
			"modelId",
			"providerId",
			"providerOptions",
		]);
		expect(target.authorization).toEqual({ apiKey: "secret", kind: "api-key" });
		expect(modelTargetSchema.safeParse(target).success).toBe(true);

		const oauthTarget = createModelTarget(
			{ modelId: "gpt-5.4-mini", providerId: "openai" },
			{ accessToken: "token", accountId: "account", kind: "oauth" }
		);
		expect(oauthTarget.authorization).toEqual({
			accessToken: "token",
			accountId: "account",
			kind: "oauth",
		});
		expect(() =>
			createModelTarget(
				{ modelId: "claude-opus-4-6", providerId: "anthropic" },
				{ accessToken: "token", accountId: "account", kind: "oauth" }
			)
		).toThrow("OAuth authorization is only supported by OpenAI");
	});

	test("preserves provider-specific variant capabilities", () => {
		expect(
			resolveModelProviderOptions(findModel("openai", "gpt-5.4-mini"), {
				variant: "high",
			})
		).toEqual({
			providerOptions: {
				openai: {
					reasoningEffort: "high",
					reasoningSummary: "detailed",
					store: false,
				},
			},
		});
		expect(
			resolveModelProviderOptions(findModel("anthropic", "claude-opus-4-6"), {
				variant: "high",
			})
		).toEqual({
			providerOptions: {
				anthropic: {
					effort: "high",
					thinking: { type: "adaptive" },
				},
			},
		});
		expect(
			resolveModelProviderOptions(findModel("anthropic", "claude-opus-4-5"), {
				variant: "high",
			})
		).toEqual({
			maxOutputTokens: 32_000,
			providerOptions: {
				anthropic: {
					effort: "high",
					thinking: { budgetTokens: 16_000, type: "enabled" },
				},
			},
		});
		for (const variant of ["low", "medium"] as const) {
			expect(
				resolveModelProviderOptions(findModel("anthropic", "claude-opus-4-5"), {
					variant,
				}).providerOptions
			).toEqual({
				anthropic: {
					effort: variant,
					thinking: { budgetTokens: 16_000, type: "enabled" },
				},
			});
		}
		expect(
			resolveModelProviderOptions(findModel("google", "gemini-3.5-flash"), {
				variant: "high",
			})
		).toEqual({
			maxOutputTokens: 32_000,
			providerOptions: {
				google: { thinkingConfig: { thinkingLevel: "high" } },
			},
		});
		expect(
			resolveModelProviderOptions(findModel("google", "gemini-2.5-flash"), {
				variant: "high",
			})
		).toEqual({
			maxOutputTokens: 32_000,
			providerOptions: {
				google: { thinkingConfig: { thinkingBudget: 12_288 } },
			},
		});
		expect(
			resolveModelProviderOptions(findModel("opencode-go", "gpt-5.6-luna"), {
				variant: "high",
			})
		).toEqual({
			providerOptions: {
				openai: {
					reasoningEffort: "high",
					reasoningSummary: "detailed",
					store: false,
				},
			},
		});
		expect(
			resolveModelProviderOptions(findModel("opencode-go", "minimax-m3"), {
				variant: "thinking",
			})
		).toEqual({
			providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
		});
		expect(
			resolveModelProviderOptions(findModel("opencode-go", "qwen3.7-max"), {
				variant: "max",
			})
		).toEqual({
			providerOptions: {
				anthropic: {
					thinking: {
						budgetTokens: 31_999,
						type: "enabled",
					},
				},
			},
		});
	});

	test("resolves every catalog model variant into a target", () => {
		for (const model of modelCatalog) {
			const selection = {
				modelId: model.id,
				providerId: model.connectionProviderId,
			};
			for (const variant of getSupportedModelVariants(selection)) {
				const target = createModelTarget(
					selection,
					{
						apiKey: `${model.connectionProviderId}-secret`,
						kind: "api-key",
					},
					{ variant }
				);
				expect(target.variant).toBe(variant);
			}
		}
	});

	test("normalizes usage and keeps model accounting provider-neutral", () => {
		const usage = normalizeModelUsage({
			inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 5 },
			inputTokens: 100,
			outputTokenDetails: { reasoningTokens: 10 },
			outputTokens: 25,
			totalTokens: 125,
		});
		expect(usage).toEqual({
			cacheReadTokens: 20,
			cacheWriteTokens: 5,
			inputTokens: 100,
			outputTokens: 25,
			reasoningTokens: 10,
			totalTokens: 125,
		});
		expect(usage && getModelContextTokens(usage)).toBe(125);
		expect(
			usage &&
				calculateModelUsageCostUsd(
					{ cacheRead: 0.1, input: 1, output: 2 },
					usage
				)
		).toBeCloseTo(0.000_132);
		expect(formatModelTokenCount(34_300)).toBe("34.3K");
		expect(
			normalizeModelUsage({
				cachedInputTokens: 4,
				inputTokens: 10,
				outputTokens: 2,
				reasoningTokens: 1,
			})
		).toEqual({
			cacheReadTokens: 4,
			inputTokens: 10,
			outputTokens: 2,
			reasoningTokens: 1,
		});
	});

	test("normalizes failures without exposing provider diagnostics", () => {
		const failure = normalizeModelFailure(
			new Error("rate limit; secret-api-key", {
				cause: {
					responseBody: JSON.stringify({ error: "429 quota exceeded" }),
					statusCode: 429,
				},
			}),
			{ modelId: "gpt-5.4-mini", providerId: "openai" }
		);
		expect(failure).toEqual({
			code: "rate-limited",
			details: {
				modelId: "gpt-5.4-mini",
				providerId: "openai",
				statusCode: 429,
			},
			message: "The model provider rate-limited the request.",
			retry: "after-delay",
			source: "provider",
			version: 1,
		});
		expect(JSON.stringify(failure)).not.toContain("secret-api-key");
		expect(modelFailureSchema.safeParse(failure).success).toBe(true);
		expect(
			normalizeModelFailure({ ...failure, message: "private diagnostic" })
				.message
		).toBe("The model provider rate-limited the request.");

		expect(
			normalizeModelFailure(
				new Error("context_length_exceeded", {
					cause: {
						responseBody: JSON.stringify({ error: "private details" }),
					},
				})
			).code
		).toBe("context-overflow");
		expect(
			normalizeModelFailure({ message: "unauthorized", statusCode: 401 }).code
		).toBe("authentication");
	});
});

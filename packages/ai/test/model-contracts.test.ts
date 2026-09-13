import { describe, expect, test } from "bun:test";
import type {
	ChatModelSelection,
	ConnectionProviderId,
	SupportedChatModel,
} from "../src/model";
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
} from "../src/model";

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
const expectedGoogleModelIds = [
	"gemini-3.6-flash",
	"gemini-3.7-flash",
	"gemini-3.8-flash",
] as const;

const expectedOpenCodeGoModels = [
	{ id: "grok-4.6", sdk: "openai-compatible" },
	{ id: "gpt-5.6-luna", sdk: "openai" },
	{ id: "glm-5.3-flash", sdk: "openai-compatible" },
	{ id: "glm-5.3", sdk: "openai-compatible" },
	{ id: "glm-5.2", sdk: "openai-compatible" },
	{ id: "glm-5.1", sdk: "openai-compatible" },
	{ id: "kimi-k3", sdk: "openai-compatible" },
	{ id: "kimi-k2.7-code", sdk: "openai-compatible" },
	{ id: "kimi-k2.6", sdk: "openai-compatible" },
	{ id: "longcat-2.0", sdk: "openai-compatible" },
	{ id: "muse-spark-1.3-contributor", sdk: "openai" },
	{ id: "muse-spark-1.2-contributor", sdk: "openai" },
	{ id: "minimax-m3", sdk: "anthropic" },
	{ id: "minimax-m2.7", sdk: "anthropic" },
	{ id: "qwen3.8-max", sdk: "anthropic" },
	{ id: "qwen3.8-flash", sdk: "anthropic" },
	{ id: "qwen3.7-max", sdk: "anthropic" },
	{ id: "qwen3.7-plus", sdk: "anthropic" },
	{ id: "qwen3.6-plus", sdk: "anthropic" },
	{ id: "deepseek-v4.1-flash", sdk: "openai-compatible" },
	{ id: "deepseek-v4-pro", sdk: "openai-compatible" },
	{ id: "deepseek-v4-flash", sdk: "openai-compatible" },
	{ id: "deepseek-v4-flash-vision-exp", sdk: "openai-compatible" },
	{ id: "mimo-v2.5", sdk: "openai-compatible" },
	{ id: "mimo-v2.5-pro", sdk: "openai-compatible" },
	{ id: "hy4-preview", sdk: "openai-compatible" },
	{ id: "hy3", sdk: "openai-compatible" },
] as const;

test("keeps the curated Google and OpenCode Go allowlists", () => {
	expect(
		modelCatalog
			.filter((model) => model.connectionProviderId === "google")
			.map((model) => model.id)
	).toEqual([...expectedGoogleModelIds]);
	expect(
		modelCatalog
			.filter((model) => model.connectionProviderId === "opencode-go")
			.map(({ id, sdk }) => ({ id, sdk }))
	).toEqual([...expectedOpenCodeGoModels]);
});

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
			modelId: "gpt-5.6-luna",
			providerId: "openai",
		};
		expect(modelSelectionSchema.parse(selection)).toEqual(selection);
		expect(
			modelSelectionSchema.safeParse({
				modelId: "claude-opus-4-6",
				providerId: "openai",
			}).success
		).toBe(false);
		expect(findSupportedChatModelSelection(selection)?.id).toBe("gpt-5.6-luna");
	});

	test("creates a transient target with minimal authorization", () => {
		const target = createModelTarget(
			{ modelId: "gpt-5.6-luna", providerId: "openai" },
			{ apiKey: "secret", kind: "api-key" }
		);
		// The default OpenAI request still carries invariant storage and summary
		// options even when no user-selected reasoning level is present.
		expect(Object.keys(target).sort()).toEqual([
			"authorization",
			"modelId",
			"providerId",
			"providerOptions",
		]);
		expect(target.authorization).toEqual({ apiKey: "secret", kind: "api-key" });
		expect(modelTargetSchema.safeParse(target).success).toBe(true);

		const oauthTarget = createModelTarget(
			{ modelId: "gpt-5.6-luna", providerId: "openai" },
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
			resolveModelProviderOptions(findModel("openai", "gpt-5.6-luna"), {
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
			resolveModelProviderOptions(findModel("openai", "gpt-5.6-luna"), {
				variant: "none",
			})
		).toEqual({
			providerOptions: {
				openai: {
					reasoningEffort: "none",
					reasoningSummary: "detailed",
					store: false,
				},
			},
		});
		expect(
			resolveModelProviderOptions(findModel("openai", "gpt-5.6-luna"))
		).toEqual({
			providerOptions: {
				openai: {
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
					thinking: { budgetTokens: 8000, type: "enabled" },
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
					thinking: { budgetTokens: 8000, type: "enabled" },
				},
			});
		}
		expect(
			getSupportedModelVariants({
				modelId: "gemini-3.6-flash",
				providerId: "google",
			})
		).toEqual(["minimal", "low", "medium", "high"]);
		expect(
			resolveModelProviderOptions(findModel("google", "gemini-3.6-flash"), {
				variant: "high",
			})
		).toEqual({
			providerOptions: {
				google: { thinkingConfig: { thinkingLevel: "high" } },
			},
		});
		expect(
			getSupportedModelVariants({
				modelId: "gemini-3.7-flash",
				providerId: "google",
			})
		).toEqual(["low", "medium", "high"]);
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
			providerOptions: {
				anthropic: { thinking: { type: "adaptive" } },
			},
		});
		expect(
			resolveModelProviderOptions(findModel("opencode-go", "qwen3.7-max"), {
				variant: "thinking",
			})
		).toEqual({
			maxOutputTokens: 32_000,
			providerOptions: {
				anthropic: {
					thinking: { budgetTokens: 8000, type: "enabled" },
				},
			},
		});
		expect(
			getSupportedModelVariants({
				modelId: "minimax-m3",
				providerId: "opencode-go",
			})
		).toEqual(["none", "thinking"]);
		expect(
			resolveModelProviderOptions(findModel("opencode-go", "qwen3.7-max"), {
				variant: "none",
			})
		).toEqual({
			providerOptions: {
				anthropic: { thinking: { type: "disabled" } },
			},
		});
	});
	test("derives budgets for unlevelled models without selectable variants", () => {
		expect(
			getSupportedModelVariants({
				modelId: "claude-haiku-4-5",
				providerId: "anthropic",
			})
		).toEqual([]);
		expect(
			resolveModelProviderOptions(findModel("anthropic", "claude-haiku-4-5"))
		).toEqual({
			maxOutputTokens: 32_000,
			providerOptions: {
				anthropic: {
					thinking: { budgetTokens: 8000, type: "enabled" },
				},
			},
		});
	});
	test("bounds thinking budgets when callers request a smaller output limit", () => {
		// The budget shrinks with the caller's cap and stays strictly below it,
		// so the answer always has room to be written.
		expect(
			resolveModelProviderOptions(findModel("anthropic", "claude-opus-4-5"), {
				maxOutputTokens: 4096,
				variant: "high",
			})
		).toEqual({
			maxOutputTokens: 4096,
			providerOptions: {
				anthropic: {
					effort: "high",
					thinking: { budgetTokens: 1024, type: "enabled" },
				},
			},
		});
		// Below the published reasoning floor there is no budget to honour, so
		// the level degrades to an explicit disable rather than an invalid one.
		expect(
			resolveModelProviderOptions(findModel("anthropic", "claude-opus-4-5"), {
				maxOutputTokens: 256,
				variant: "high",
			})
		).toEqual({
			maxOutputTokens: 256,
			providerOptions: {
				anthropic: {
					effort: "high",
					thinking: { type: "disabled" },
				},
			},
		});
	});

	test("does not offer reasoning variants unsupported by compatible adapters", () => {
		const selection = {
			modelId: "grok-4.6",
			providerId: "opencode-go",
		} as const;
		expect(getSupportedModelVariants(selection)).toEqual([]);
		expect(() =>
			createModelTarget(
				selection,
				{ apiKey: "opencode-go-secret", kind: "api-key" },
				{ variant: "high" }
			)
		).toThrow("Unsupported model variant");
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
		).toBeCloseTo(0.000_127);
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
			{ modelId: "gpt-5.6-luna", providerId: "openai" }
		);
		expect(failure).toEqual({
			code: "rate-limited",
			details: {
				modelId: "gpt-5.6-luna",
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

	test("unwraps stream error envelopes before classifying failures", () => {
		expect(
			normalizeModelFailure({
				error: { message: "bad request", statusCode: 400 },
			}).code
		).toBe("invalid-request");
	});
});

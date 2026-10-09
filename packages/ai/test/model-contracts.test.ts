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
	getSupportedThinkingLevels,
	modelCatalog,
	modelFailureSchema,
	modelSelectionSchema,
	modelTargetSchema,
	normalizeModelFailure,
	normalizeModelUsage,
	normalizeThinkingLevel,
	resolveAgentModelSelection,
	resolveModelProviderOptions,
	supportedChatModelIdSchema,
	thinkingLevelIds,
	thinkingLevelSchema,
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
const modelId = (value: string) => supportedChatModelIdSchema.parse(value);
const expectedGoogleModelIds = [
	"gemini-3.6-flash",
	"gemini-3.7-flash",
	"gemini-3.8-flash",
] as const;

const expectedOpenCodeGoModels = [
	{ id: "grok-4.6", protocol: "openai-compatible" },
	{ id: "gpt-5.6-luna", protocol: "openai" },
	{ id: "glm-5.3-flash", protocol: "openai-compatible" },
	{ id: "glm-5.3", protocol: "openai-compatible" },
	{ id: "glm-5.2", protocol: "openai-compatible" },
	{ id: "glm-5.1", protocol: "openai-compatible" },
	{ id: "kimi-k3", protocol: "openai-compatible" },
	{ id: "kimi-k2.7-code", protocol: "openai-compatible" },
	{ id: "kimi-k2.6", protocol: "openai-compatible" },
	{ id: "longcat-2.0", protocol: "openai-compatible" },
	{ id: "muse-spark-1.3-contributor", protocol: "openai" },
	{ id: "muse-spark-1.2-contributor", protocol: "openai" },
	{ id: "minimax-m3", protocol: "anthropic" },
	{ id: "minimax-m2.7", protocol: "anthropic" },
	{ id: "qwen3.8-max", protocol: "anthropic" },
	{ id: "qwen3.8-flash", protocol: "anthropic" },
	{ id: "qwen3.7-max", protocol: "anthropic" },
	{ id: "qwen3.7-plus", protocol: "anthropic" },
	{ id: "qwen3.6-plus", protocol: "anthropic" },
	{ id: "deepseek-v4.1-flash", protocol: "openai-compatible" },
	{ id: "deepseek-v4-pro", protocol: "openai-compatible" },
	{ id: "deepseek-v4-flash", protocol: "openai-compatible" },
	{ id: "deepseek-v4-flash-vision-exp", protocol: "openai-compatible" },
	{ id: "mimo-v2.5", protocol: "openai-compatible" },
	{ id: "mimo-v2.5-pro", protocol: "openai-compatible" },
	{ id: "hy4-preview", protocol: "openai-compatible" },
	{ id: "hy3", protocol: "openai-compatible" },
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
			.map(({ id, protocol }) => ({ id, protocol }))
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
			modelId: modelId("gpt-5.6-luna"),
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

	test("validates a single Agent thinking level against the selected model", () => {
		const valid = resolveAgentModelSelection({
			model: "openai/gpt-5.6-luna",
			thinkingLevel: "high",
		});
		expect(valid).toEqual({
			invalidModel: false,
			invalidThinkingLevel: false,
			model: { modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
		});

		const unsupported = resolveAgentModelSelection({
			model: "openai/unknown-model",
			thinkingLevel: "high",
		});
		expect(unsupported).toMatchObject({
			invalidThinkingLevel: true,
			invalidModel: true,
			model: undefined,
		});

		const unavailableLevel = resolveAgentModelSelection({
			model: "opencode-go/grok-4.6",
			thinkingLevel: "high",
		});
		expect(unavailableLevel.invalidThinkingLevel).toBe(true);
	});

	test("resolves every requested direct model from the catalog", () => {
		const requestedDirectModels = [
			{ providerId: "openai", id: "gpt-6-sol", displayName: "GPT-6 Sol" },
			{
				providerId: "openai",
				id: "gpt-6.1-sol",
				displayName: "GPT-6.1 Sol",
			},
			{ providerId: "openai", id: "gpt-6-luna", displayName: "GPT-6 Luna" },
			{ providerId: "openai", id: "gpt-6-terra", displayName: "GPT-6 Terra" },
			{
				providerId: "anthropic",
				id: "claude-opus-5.5",
				displayName: "Claude Opus 5.5",
			},
		] as const;
		for (const expected of requestedDirectModels) {
			expect(
				modelCatalog.find(
					(model) =>
						model.connectionProviderId === expected.providerId &&
						model.id === expected.id
				)
			).toMatchObject({
				displayName: expected.displayName,
				lifecycle: "active",
				provider: expected.providerId,
				route: "direct",
			});
		}
	});

	test("creates a transient target with minimal authorization", () => {
		const target = createModelTarget(
			{ modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
			{ apiKey: "secret", kind: "api-key" }
		);
		// The default OpenAI request still carries invariant storage and summary
		// options even when no Thinking level is selected.
		expect(Object.keys(target).sort()).toEqual([
			"authorization",
			"modelId",
			"providerId",
			"providerOptions",
		]);
		expect(target.authorization).toEqual({ apiKey: "secret", kind: "api-key" });
		expect(modelTargetSchema.safeParse(target).success).toBe(true);

		const oauthTarget = createModelTarget(
			{ modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
			{ accessToken: "token", accountId: "account", kind: "oauth" }
		);
		expect(oauthTarget.authorization).toEqual({
			accessToken: "token",
			accountId: "account",
			kind: "oauth",
		});
		expect(() =>
			createModelTarget(
				{ modelId: modelId("claude-opus-4-6"), providerId: "anthropic" },
				{ accessToken: "token", accountId: "account", kind: "oauth" }
			)
		).toThrow("OAuth authorization is only supported by OpenAI");
	});

	test("offers each model's mapped Thinking levels and preserves toggle aliases", () => {
		const googleSelection = {
			modelId: modelId("gemini-3.6-flash"),
			providerId: "google",
		} as const;
		expect(getSupportedThinkingLevels(googleSelection)).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
		]);

		const openAiSelection = {
			modelId: modelId("gpt-5.6-luna"),
			providerId: "openai",
		} as const;
		expect(getSupportedThinkingLevels(openAiSelection)).toEqual([
			"off",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);

		for (const id of ["hy3", "hy4-preview"] as const) {
			expect(
				getSupportedThinkingLevels({
					modelId: modelId(id),
					providerId: "opencode-go",
				})
			).toEqual([]);
		}

		const ladderAndToggleSelection = {
			modelId: modelId("qwen3.8-max"),
			providerId: "opencode-go",
		} as const;
		expect(getSupportedThinkingLevels(ladderAndToggleSelection)).toEqual([
			"off",
			"low",
			"medium",
			"xhigh",
		]);
		expect(
			normalizeThinkingLevel(ladderAndToggleSelection, "thinking")
		).toBeUndefined();

		const toggleOnlySelection = {
			modelId: modelId("minimax-m3"),
			providerId: "opencode-go",
		} as const;
		expect(getSupportedThinkingLevels(toggleOnlySelection)).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(normalizeThinkingLevel(toggleOnlySelection, "high")).toBe("high");

		const unlevelledSelection = {
			modelId: modelId("claude-haiku-4-5"),
			providerId: "anthropic",
		} as const;
		expect(getSupportedThinkingLevels(unlevelledSelection)).toEqual([]);
		expect(thinkingLevelIds).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(thinkingLevelSchema.safeParse("min").success).toBe(false);
		expect(thinkingLevelSchema.safeParse("off").success).toBe(true);
		expect(thinkingLevelSchema.safeParse("thinking").success).toBe(false);
		expect(normalizeThinkingLevel(googleSelection, "minimal")).toBe("minimal");
		expect(normalizeThinkingLevel(googleSelection, "min")).toBeUndefined();
	});

	test("translates Thinking levels into provider-specific request options", () => {
		expect(
			resolveModelProviderOptions(findModel("openai", "gpt-5.6-luna"), {
				thinkingLevel: "high",
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
				thinkingLevel: "off",
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
				thinkingLevel: "high",
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
				thinkingLevel: "high",
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
		expect(
			resolveModelProviderOptions(findModel("google", "gemini-3.6-flash"), {
				thinkingLevel: "high",
			})
		).toEqual({
			providerOptions: {
				google: { thinkingConfig: { thinkingLevel: "high" } },
			},
		});
		expect(
			resolveModelProviderOptions(findModel("opencode-go", "qwen3.8-max"), {
				thinkingLevel: "off",
			})
		).toEqual({
			providerOptions: {
				anthropic: { thinking: { type: "disabled" } },
			},
		});
		expect(
			resolveModelProviderOptions(findModel("opencode-go", "qwen3.7-max"), {
				thinkingLevel: "high",
			})
		).toEqual({
			maxOutputTokens: 32_000,
			providerOptions: {
				anthropic: {
					thinking: { budgetTokens: 8000, type: "enabled" },
				},
			},
		});
	});

	test("rejects malformed and unsupported Thinking levels before sending a target", () => {
		const openAiModel = {
			modelId: modelId("gpt-5.6-luna"),
			providerId: "openai",
		} as const;
		const target = createModelTarget(
			openAiModel,
			{
				apiKey: "secret",
				kind: "api-key",
			},
			{ thinkingLevel: "high" }
		);
		expect(target).toHaveProperty("thinkingLevel", "high");
		expect(target).not.toHaveProperty("variant");
		expect(
			modelTargetSchema.safeParse({
				...target,
				effort: "high",
			}).success
		).toBe(false);
		expect(
			modelTargetSchema.safeParse({
				...target,
				variant: "high",
			}).success
		).toBe(false);

		const malformedLevel = modelTargetSchema.safeParse({
			...target,
			thinkingLevel: "on",
		});
		expect(malformedLevel.success).toBe(false);
		if (!malformedLevel.success) {
			expect(malformedLevel.error.issues[0]?.message).toContain(
				"Thinking level"
			);
		}

		expect(() =>
			createModelTarget(
				{ modelId: modelId("grok-4.6"), providerId: "opencode-go" },
				{ apiKey: "opencode-go-secret", kind: "api-key" },
				{ thinkingLevel: "high" }
			)
		).toThrow("Unsupported Thinking level");
	});

	test("derives budgets for unlevelled models without selectable reasoning choices", () => {
		const selection = {
			modelId: modelId("claude-haiku-4-5"),
			providerId: "anthropic",
		} as const;
		expect(getSupportedThinkingLevels(selection)).toEqual([]);
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

	test("bounds Thinking-level reasoning budgets to the requested output limit", () => {
		expect(
			resolveModelProviderOptions(findModel("anthropic", "claude-opus-4-5"), {
				maxOutputTokens: 4096,
				thinkingLevel: "high",
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
		expect(
			resolveModelProviderOptions(findModel("anthropic", "claude-opus-4-5"), {
				maxOutputTokens: 256,
				thinkingLevel: "high",
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

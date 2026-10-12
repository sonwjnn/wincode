import { describe, expect, test } from "bun:test";
import {
	type ConnectionProviderId,
	findSupportedChatModelSelection,
	openAIPromptCacheProtocolForModel,
	promptCacheRetentionTtlMsForModel,
	supportedChatModelIdSchema,
	supportsPromptCacheWarmingForModel,
} from "../src/models";

const model = (providerId: ConnectionProviderId, modelId: string) => {
	const found = findSupportedChatModelSelection({
		modelId: supportedChatModelIdSchema.parse(modelId),
		providerId,
	});
	if (!found) {
		throw new Error(`Fixture model ${providerId}/${modelId} is unavailable.`);
	}
	return found;
};

describe("promptCacheRetentionTtlMsForModel", () => {
	test("returns only the TTL verified for the selected protocol and tier", () => {
		expect(
			promptCacheRetentionTtlMsForModel(
				model("anthropic", "claude-haiku-4-5"),
				"short"
			)
		).toBe(5 * 60_000);
		expect(
			promptCacheRetentionTtlMsForModel(
				model("anthropic", "claude-haiku-4-5"),
				"long"
			)
		).toBe(60 * 60_000);
		expect(
			promptCacheRetentionTtlMsForModel(model("openai", "gpt-5.6"), "short")
		).toBe(30 * 60_000);
	});

	test("does not guess unsupported, unknown, or Google resource lifetimes", () => {
		expect(
			promptCacheRetentionTtlMsForModel(model("openai", "gpt-5.6"), "long")
		).toBeUndefined();
		expect(
			promptCacheRetentionTtlMsForModel(
				model("google", "gemini-3.8-flash"),
				"short"
			)
		).toBeUndefined();
	});

	test("routes OpenCode Go cache policy through its selected Model Protocol", () => {
		expect(
			openAIPromptCacheProtocolForModel(model("opencode-go", "gpt-5.6-luna"))
		).toBe("openai-responses");
		expect(
			openAIPromptCacheProtocolForModel(model("opencode-go", "grok-4.6"))
		).toBe("openai-chat");
	});

	test("resolves warm-request support from protocol capability declarations", () => {
		expect(supportsPromptCacheWarmingForModel(model("openai", "gpt-5.6"))).toBe(
			true
		);
		expect(
			supportsPromptCacheWarmingForModel(model("google", "gemini-3.8-flash"))
		).toBe(false);
	});
});

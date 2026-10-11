import { describe, expect, test } from "bun:test";
import {
	type ConnectionProviderId,
	findSupportedChatModelSelection,
	promptCacheRetentionTtlMsForModel,
	supportedChatModelIdSchema,
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
});

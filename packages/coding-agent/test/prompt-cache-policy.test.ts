import { expect, test } from "bun:test";
import type { ProviderModel } from "@wincode/ai/sdk";
import { resolveConfiguredPromptCacheControls } from "@/modules/prompt-cache/policy";

const providerModel = (
	providerId: string,
	modelId: string,
	promptCacheRetentionTiers?: ProviderModel["promptCacheRetentionTiers"]
): ProviderModel => ({
	modelId,
	protocolId: "fixture",
	providerId,
	...(promptCacheRetentionTiers === undefined
		? {}
		: { promptCacheRetentionTiers }),
});

test("uses the default tier and honors only declared Provider Model overrides", () => {
	const opus = providerModel("anthropic", "claude-opus-4-5", ["short", "long"]);
	const opencodeAnthropic = providerModel("opencode-go", "minimax-m3", [
		"short",
	]);

	expect(resolveConfiguredPromptCacheControls(opus, undefined)).toEqual({
		enabled: true,
		retention: "short",
	});
	expect(
		resolveConfiguredPromptCacheControls(opus, {
			modelOverrides: { "anthropic/claude-opus-4-5": "long" },
		})
	).toEqual({ enabled: true, retention: "long" });
	expect(
		resolveConfiguredPromptCacheControls(opus, {
			modelOverrides: { "anthropic/claude-opus-4-5": "off" },
		})
	).toEqual({ enabled: false });
	expect(
		resolveConfiguredPromptCacheControls(opencodeAnthropic, {
			modelOverrides: { "opencode-go/minimax-m3": "long" },
		})
	).toEqual({ enabled: false });
	expect(
		resolveConfiguredPromptCacheControls(opus, {
			modelOverrides: { "anthropic/claude-opus-4-5": "invalid" },
		})
	).toEqual({ enabled: false });
});

test("requires explicit Provider Model retention metadata before enabling cache", () => {
	const undeclared = providerModel("fixture", "undeclared");

	expect(resolveConfiguredPromptCacheControls(undeclared, undefined)).toEqual({
		enabled: false,
	});
	expect(
		resolveConfiguredPromptCacheControls(undeclared, {
			modelOverrides: { "fixture/undeclared": "short" },
		})
	).toEqual({ enabled: false });
});

test("does not apply a cache override to a different Provider Model identity", () => {
	const openai = providerModel("openai", "gpt-5.6-luna", ["short"]);
	const openCodeGoOpenAI = providerModel("opencode-go", "gpt-5.6-luna", [
		"short",
	]);

	expect(resolveConfiguredPromptCacheControls(openai, undefined)).toEqual({
		enabled: true,
		retention: "short",
	});
	expect(
		resolveConfiguredPromptCacheControls(openai, {
			modelOverrides: { "openai/gpt-5.6-luna": "off" },
		})
	).toEqual({ enabled: false });
	expect(
		resolveConfiguredPromptCacheControls(openCodeGoOpenAI, {
			modelOverrides: { "openai/gpt-5.6-luna": "off" },
		})
	).toEqual({ enabled: true, retention: "short" });
});

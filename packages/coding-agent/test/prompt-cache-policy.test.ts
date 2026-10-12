import { expect, test } from "bun:test";
import { modelCatalog } from "@wincode/ai/models";
import {
	resolveConfiguredPromptCacheControls,
	resolveConfiguredPromptCacheRetention,
} from "@/modules/prompt-cache/policy";

test("uses short by default and honors only capability-supported model overrides", () => {
	const opus = modelCatalog.find(
		(model) =>
			model.connectionProviderId === "anthropic" &&
			model.id === "claude-opus-4-5"
	);
	const opencodeAnthropic = modelCatalog.find(
		(model) =>
			model.connectionProviderId === "opencode-go" && model.id === "minimax-m3"
	);
	if (!(opus && opencodeAnthropic)) {
		throw new Error("Prompt cache model fixtures are missing.");
	}

	expect(resolveConfiguredPromptCacheRetention(opus, undefined)).toBe("short");
	expect(
		resolveConfiguredPromptCacheRetention(opus, {
			modelOverrides: { "anthropic/claude-opus-4-5": "long" },
		})
	).toBe("long");
	expect(
		resolveConfiguredPromptCacheRetention(opus, {
			modelOverrides: { "anthropic/claude-opus-4-5": "off" },
		})
	).toBeUndefined();
	expect(
		resolveConfiguredPromptCacheRetention(opencodeAnthropic, {
			modelOverrides: { "opencode-go/minimax-m3": "long" },
		})
	).toBeUndefined();
	expect(
		resolveConfiguredPromptCacheRetention(opus, {
			modelOverrides: { "anthropic/claude-opus-4-5": "invalid" },
		})
	).toBeUndefined();
});

test("enables only declared controls and lets off omit the Session key", () => {
	const openai = modelCatalog.find(
		(model) =>
			model.connectionProviderId === "openai" && model.id === "gpt-5.6-luna"
	);
	const openCodeGoOpenAI = modelCatalog.find(
		(model) =>
			model.connectionProviderId === "opencode-go" &&
			model.id === "gpt-5.6-luna"
	);
	if (!(openai && openCodeGoOpenAI)) {
		throw new Error("Prompt cache model fixtures are missing.");
	}

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
		resolveConfiguredPromptCacheControls(openCodeGoOpenAI, undefined)
	).toEqual({ enabled: false });
});

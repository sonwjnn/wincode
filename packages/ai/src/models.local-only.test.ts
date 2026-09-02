import { describe, expect, test } from "bun:test";
import {
	defaultChatModelSelection,
	findSupportedChatModelSelection,
	getChatModelRoute,
	normalizeChatModelSelection,
	supportedChatModels,
} from "./models";

describe("direct model catalog", () => {
	test("uses GPT-5.4 Mini with low reasoning as the default", () => {
		expect(defaultChatModelSelection).toEqual({
			modelId: "gpt-5.4-mini",
			providerId: "openai",
		});
		expect(getChatModelRoute(defaultChatModelSelection)).toBe("direct");
	});

	test("exposes only direct selectable models", () => {
		expect(supportedChatModels.every((model) => model.route === "direct")).toBe(
			true
		);
		expect(
			supportedChatModels.some(
				(model) => String(model.connectionProviderId) === "wincode"
			)
		).toBe(false);
	});

	test("does not normalize retired provider selections", () => {
		const selection = {
			modelId: "gpt-5.4-mini",
			providerId: "wincode",
		} as never;
		expect(findSupportedChatModelSelection(selection)).toBeNull();
		expect(normalizeChatModelSelection(selection)).toBeNull();
	});
});

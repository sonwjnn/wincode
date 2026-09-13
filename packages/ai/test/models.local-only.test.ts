import { describe, expect, test } from "bun:test";
import {
	defaultChatModelSelection,
	findSupportedChatModelSelection,
	getChatModelRoute,
	modelCatalog,
	normalizeChatModelSelection,
} from "../src/models";

describe("direct model catalog", () => {
	test("uses GPT-5.6 Luna with low reasoning as the default", () => {
		expect(defaultChatModelSelection).toEqual({
			modelId: "gpt-5.6-luna",
			providerId: "openai",
		});
		expect(getChatModelRoute(defaultChatModelSelection)).toBe("direct");
	});

	test("exposes only direct selectable models", () => {
		expect(modelCatalog.every((model) => model.route === "direct")).toBe(true);
		expect(
			modelCatalog.some(
				(model) => String(model.connectionProviderId) === "wincode"
			)
		).toBe(false);
	});

	test("does not normalize retired provider selections", () => {
		const selection = {
			modelId: "gpt-5.6-luna",
			providerId: "wincode",
		} as never;
		expect(findSupportedChatModelSelection(selection)).toBeNull();
		expect(normalizeChatModelSelection(selection)).toBeNull();
	});
});

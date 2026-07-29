import { describe, expect, test } from "bun:test";
import { hasChatPromptContent } from "./chat-view";

describe("hasChatPromptContent", () => {
	test("accepts a zero-argument skill invocation", () => {
		expect(
			hasChatPromptContent({
				files: [],
				skill: {
					arguments: "",
					instructions: "Review the implementation carefully.",
					name: "review",
				},
				text: "",
			})
		).toBe(true);
	});

	test("rejects an empty prompt without files or skill context", () => {
		expect(hasChatPromptContent({ files: [], text: "  " })).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import {
	getSessionTitle,
	resolveLoadedChatMessageMetadata,
	resolvePersistedChatMessageMetadata,
} from "./chat-message-metadata";

describe("chat message metadata persistence", () => {
	test("preserves message metadata when persisting with request fallback values", () => {
		expect(
			resolvePersistedChatMessageMetadata(
				{
					mode: "plan",
					model: "gemini-3.5-flash",
				},
				"build",
				"gpt-5.4-mini"
			)
		).toEqual({
			mode: "plan",
			model: "gemini-3.5-flash",
		});
	});

	test("fills missing persisted metadata from request values", () => {
		expect(
			resolvePersistedChatMessageMetadata({}, "build", "gpt-5.4-mini")
		).toEqual({
			mode: "build",
			model: "gpt-5.4-mini",
		});
	});

	test("preserves loaded JSON metadata over database fallback mode", () => {
		expect(
			resolveLoadedChatMessageMetadata(
				{
					mode: "plan",
					model: "gemini-3.5-flash",
				},
				"build"
			)
		).toEqual({
			mode: "plan",
			model: "gemini-3.5-flash",
		});
	});

	test("derives session title from first user text part", () => {
		expect(
			getSessionTitle([
				{
					parts: [
						{ text: "  Fix the dialog menu integration  ", type: "text" },
					],
					role: "user",
				},
			])
		).toBe("Fix the dialog menu integration");
	});

	test("falls back to untitled session without user text", () => {
		expect(
			getSessionTitle([
				{
					parts: [{ text: "assistant reply", type: "text" }],
					role: "assistant",
				},
			])
		).toBe("Untitled session");
	});
});

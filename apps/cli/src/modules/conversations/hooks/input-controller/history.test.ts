import { describe, expect, test } from "bun:test";
import type { ConversationMessage } from "@/modules/conversations/message";
import type { HistoryState, PromptHistoryEntry } from "./history";
import {
	derivePromptHistory,
	mergePromptHistory,
	navigateHistory,
	prependPrompt,
	resetHistoryNavigation,
	shouldRecordCtrlC,
} from "./history";

const entry = (text: string): PromptHistoryEntry => ({ text, files: [] });

describe("prompt history rules", () => {
	test("navigates newest-first and restores draft", () => {
		const draftImage = {
			filename: "clipboard",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,ZHJhZnQ=",
		} as const;
		let state: HistoryState = {
			entries: [entry("new"), entry("old")],
			index: -1,
			draft: {
				fileTokens: [{ start: 0, token: "[Image 1] " }],
				files: [draftImage],
				text: "[Image 1] draft",
			},
		};
		const result = navigateHistory(state, "up");
		expect(result.entry.text).toBe("new");
		state = result.state;
		state = navigateHistory(state, "up").state;
		expect(navigateHistory(state, "up").consumed).toBe(false);
		expect(
			navigateHistory(navigateHistory(state, "down").state, "down").entry
		).toEqual({
			fileTokens: [{ start: 0, token: "[Image 1] " }],
			files: [draftImage],
			text: "[Image 1] draft",
		});
	});

	test("rejects empty history and resets edits", () => {
		expect(
			navigateHistory({ entries: [], index: -1, draft: entry("x") }, "up")
				.consumed
		).toBe(false);
		expect(resetHistoryNavigation("edited")).toEqual({
			draft: entry("edited"),
			index: -1,
		});
	});

	test("applies exact Ctrl+C threshold and consecutive retention", () => {
		expect(shouldRecordCtrlC("x".repeat(19))).toBe(false);
		expect(shouldRecordCtrlC(`  ${"x".repeat(20)}`)).toBe(true);
		expect(shouldRecordCtrlC("[Pasted ~3 lines]", true)).toBe(true);
		const entries = prependPrompt(
			prependPrompt([entry("same"), entry("old")], entry("same")),
			entry("same")
		);
		expect(entries).toEqual([entry("same"), entry("old")]);
		expect(
			prependPrompt(
				Array.from({ length: 50 }, (_, i) => entry(`${i}`)),
				entry("new")
			)
		).toHaveLength(50);
	});

	test("retains image parts in in-memory history", () => {
		const image = {
			filename: "clipboard",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,aGVsbG8=",
		} as const;
		const prompt = {
			fileTokens: [{ start: 0, token: "[Image 1] " }],
			files: [image],
			text: "[Image 1] explain this image",
		};

		expect(prependPrompt([], prompt)).toEqual([prompt]);
	});

	test("derives newest-first image attachments from session user messages", () => {
		const firstImage = {
			filename: "first.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,first",
		} as const;
		const secondImage = {
			filename: "second.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,second",
		} as const;
		const messages = [
			{
				id: "user-1",
				parts: [{ text: "[Image 1] first", type: "text" }, firstImage],
				role: "user",
			},
			{
				id: "assistant-1",
				parts: [{ text: "ignored", type: "text" }],
				role: "assistant",
			},
			{
				id: "user-2",
				parts: [{ text: "[Image 1] second", type: "text" }, secondImage],
				role: "user",
			},
		] as unknown as ConversationMessage[];

		expect(derivePromptHistory(messages)).toEqual([
			{ files: [secondImage], text: "[Image 1] second" },
			{ files: [firstImage], text: "[Image 1] first" },
		]);
	});

	test("prefers structured session entries over matching global text entries", () => {
		const image = {
			filename: "clipboard",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,aGVsbG8=",
		} as const;
		const structured = {
			files: [image],
			text: "summarize [Image 1]",
		};

		expect(
			mergePromptHistory(
				[structured],
				[entry("summarize [Image 1]"), entry("older")]
			)
		).toEqual([structured, entry("older")]);
	});

	test("removes only matching global occurrences", () => {
		expect(
			mergePromptHistory(
				[entry("repeat")],
				[entry("repeat"), entry("repeat"), entry("older")]
			)
		).toEqual([entry("repeat"), entry("repeat"), entry("older")]);
	});

	test("enriches session files from the matching structured global entry", () => {
		const imageA = {
			filename: "a.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,YQ==",
		} as const;
		const imageB = {
			filename: "b.png",
			mediaType: "image/png",
			type: "file",
			url: "data:image/png;base64,Yg==",
		} as const;
		const sessionEntry = { files: [imageA], text: "same [Image 1]" };
		const globalB = {
			fileTokens: [{ start: 5, token: "[Image 1]" }],
			files: [imageB],
			text: sessionEntry.text,
		};
		const globalA = {
			fileTokens: [{ start: 5, token: "[Image 1]" }],
			files: [imageA],
			text: sessionEntry.text,
		};

		expect(mergePromptHistory([sessionEntry], [globalB, globalA])).toEqual([
			{ ...sessionEntry, fileTokens: globalA.fileTokens },
			globalB,
		]);
	});

	test("restores summarized pasted text instead of expanded session text", () => {
		const token = "[Pasted ~3 lines]";
		const pastedText = [{ text: "alpha\nbeta\ngamma", token }];
		const sessionEntry = entry("before alpha\nbeta\ngamma after");
		const globalEntry = {
			files: [],
			pastedText,
			text: `before ${token} after`,
		};

		expect(mergePromptHistory([sessionEntry], [globalEntry])).toEqual([
			globalEntry,
		]);
	});
});

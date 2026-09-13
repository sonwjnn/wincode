import { describe, expect, test } from "bun:test";
import {
	areFileMentionExtmarksCurrent,
	findImageTokenRanges,
	getImageToken,
	getNextImageLabel,
	isAttachmentTokenExtant,
	locateAttachmentTokens,
	mapOffsetThroughTextReplacement,
	normalizeFileTokensForTrimmedText,
} from "@/modules/sessions/attachments";
import { CHAT_TEXT_AREA_KEY_BINDINGS } from "@/shared/providers/keyboard-layer/constants";

describe("ChatTextArea", () => {
	test("binds enter to submit and modified enter to newline", () => {
		expect(CHAT_TEXT_AREA_KEY_BINDINGS).toEqual([
			{ action: "submit", name: "return" },
			{ action: "submit", name: "enter" },
			{ action: "newline", name: "return", shift: true },
			{ action: "newline", name: "enter", shift: true },
			{ action: "newline", ctrl: true, name: "return" },
			{ action: "newline", ctrl: true, name: "enter" },
		]);
	});

	test("keeps only attachments whose extmarks still cover their tokens", () => {
		const token = getImageToken(4);
		const text = `Before ${token}after`;
		const start = text.indexOf(token);

		expect(getImageToken(4)).toBe("[Image 4]");
		expect(
			isAttachmentTokenExtant(text, token, {
				end: start + token.length,
				start,
			})
		).toBe(true);
		expect(
			isAttachmentTokenExtant("Before after", token, {
				end: start + token.length,
				start,
			})
		).toBe(false);
	});

	test("numbers pasted images from the current attachment count", () => {
		expect(getNextImageLabel(0)).toBe(1);
		expect(getNextImageLabel(1)).toBe(2);
		expect(getNextImageLabel(3)).toBe(4);
	});

	test("keeps trailing spaces outside persisted image token ranges", () => {
		expect(findImageTokenRanges("[Image 1] explain [Image 3]")).toEqual([
			{ label: 1, start: 0, token: "[Image 1]" },
			{ label: 3, start: 18, token: "[Image 3]" },
		]);
	});

	test("relocates attachments after programmatic file mention edits", () => {
		const attachment = {
			extmarkId: 1,
			file: {
				filename: "clipboard",
				mediaType: "image/png",
				type: "file" as const,
				url: "data:image/png;base64,aGVsbG8=",
			},
			id: "image-1",
			token: "[Image 1]",
		};

		expect(
			locateAttachmentTokens("Prompt [Image 1] @src/app.tsx", [attachment])
		).toEqual([{ attachment, start: 7 }]);

		const promptWithLiteralToken =
			"[Image 1] literal Prompt [Image 1] @src/app.tsx";
		expect(
			locateAttachmentTokens(promptWithLiteralToken, [attachment], [25])
		).toEqual([
			{ attachment, start: promptWithLiteralToken.lastIndexOf("[Image 1]") },
		]);
	});

	test("maps attachment offsets through one programmatic text replacement", () => {
		expect(
			mapOffsetThroughTextReplacement(
				"before @sr [Image 1] after",
				"before @src/app.ts [Image 1] after",
				11
			)
		).toBe(19);
		expect(
			mapOffsetThroughTextReplacement(
				"[Image 1] before @src/app.ts ",
				"[Image 1] before ",
				0
			)
		).toBe(0);
	});

	test("normalizes recalled image tokens to trimmed submission text", () => {
		expect(
			normalizeFileTokensForTrimmedText("  [Image 1] ", [
				{ start: 2, token: "[Image 1] " },
			])
		).toEqual([{ start: 0, token: "[Image 1]" }]);
	});

	test("keeps stable file mention extmarks while typing outside mentions", () => {
		expect(
			areFileMentionExtmarksCurrent(
				[{ end: 11, start: 0 }],
				[{ end: 11, start: 0, styleId: 4 }],
				4
			)
		).toBe(true);
		expect(
			areFileMentionExtmarksCurrent(
				[{ end: 12, start: 1 }],
				[{ end: 11, start: 0, styleId: 4 }],
				4
			)
		).toBe(false);
	});
});

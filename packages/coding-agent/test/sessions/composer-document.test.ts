import { describe, expect, test } from "bun:test";
import type { SessionFilePart } from "@/modules/sessions/message";
import { expandPastedText } from "@/modules/sessions/pasted-text";
import { createComposerDocument } from "@/modules/sessions/ui/composer-document";
import { createMemoryComposerEditor } from "../support/composer-document-editor";

const imageFile = (filename: string): SessionFilePart => ({
	filename,
	mediaType: "image/png",
	type: "file",
	url: `data:image/png;base64,${filename}`,
});

describe("Composer Document", () => {
	test("restored text and cursor reach the editor through the same document owner", () => {
		const document = createComposerDocument();
		const restored = document.replaceText("working draft", 8);
		const editor = createMemoryComposerEditor();

		const attached = document.attachEditor(editor.adapter);

		expect(attached).toMatchObject({ text: "working draft", cursorOffset: 8 });
		expect(editor.adapter.getText()).toBe("working draft");
		expect(editor.adapter.getCursorOffset()).toBe(8);
		expect(restored.text).toBe(attached.text);
	});

	test("removing a tracked image token cannot attach its file to a literal lookalike", () => {
		const text = "[Image 1] quoted; [Image 1]";
		const trackedStart = text.lastIndexOf("[Image 1]");
		const editor = createMemoryComposerEditor();
		const document = createComposerDocument(editor.adapter);
		document.restore(
			{
				fileTokens: [{ start: trackedStart, token: "[Image 1]" }],
				files: [imageFile("actual.png")],
				text,
			},
			trackedStart
		);

		editor.editText("[Image 1] quoted; removed", 25);

		const change = document.observeEditorChange();
		expect(change).toMatchObject({
			previousText: text,
			snapshot: {
				fileTokens: [],
				files: [],
				text: "[Image 1] quoted; removed",
			},
		});
	});

	test("removed programmatic token ranges cannot rebind payloads to literal lookalikes", () => {
		const imageToken = "[Image 1]";
		const pastedToken = "[Pasted ~3 lines]";
		const literalText = `${imageToken} literal; ${pastedToken} literal; `;
		const text = `${literalText}${imageToken} ${pastedToken}`;
		const editor = createMemoryComposerEditor();
		const document = createComposerDocument(editor.adapter);
		document.restore(
			{
				fileTokens: [{ start: literalText.length, token: imageToken }],
				files: [imageFile("actual.png")],
				pastedText: [
					{
						start: literalText.length + imageToken.length + 1,
						text: "actual\npasted\ncontent",
						token: pastedToken,
					},
				],
				text,
			},
			text.length
		);

		const snapshot = document.replaceText(`${literalText}removed`, null);

		expect(snapshot).toMatchObject({
			fileTokens: [],
			files: [],
			pastedText: [],
			text: `${literalText}removed`,
		});
	});

	test("programmatic replacement keeps attachment and pasted payloads at their intended duplicate-token occurrences", () => {
		const imageToken = "[Image 1]";
		const pastedToken = "[Pasted ~3 lines]";
		const text = `${imageToken} is literal; actual ${imageToken} ${pastedToken}`;
		const actualImageStart = text.lastIndexOf(imageToken);
		const pastedStart = text.indexOf(pastedToken);
		const editor = createMemoryComposerEditor();
		const document = createComposerDocument(editor.adapter);
		document.restore(
			{
				fileTokens: [{ start: actualImageStart, token: imageToken }],
				files: [imageFile("actual.png")],
				pastedText: [
					{ text: "line one\nline two\nline three", token: pastedToken },
				],
				text,
			},
			text.length
		);

		const replacement = `prefix ${text}`;
		const snapshot = document.replaceText(replacement, replacement.length);

		expect(snapshot.fileTokens).toEqual([
			{ start: actualImageStart + "prefix ".length, token: imageToken },
		]);
		expect(snapshot.pastedText).toEqual([
			{
				start: pastedStart + "prefix ".length,
				text: "line one\nline two\nline three",
				token: pastedToken,
			},
		]);
		expect(snapshot.text).toBe(replacement);
		expect(snapshot.cursorOffset).toBe(replacement.length);
		expect(pastedStart).toBeGreaterThan(actualImageStart);
	});

	test("attachment order follows the edited order of image tokens", () => {
		const editor = createMemoryComposerEditor();
		const document = createComposerDocument(editor.adapter);
		const initialText = "[Image 1] then [Image 2]";
		document.restore(
			{
				fileTokens: [
					{ start: 0, token: "[Image 1]" },
					{ start: 15, token: "[Image 2]" },
				],
				files: [imageFile("first.png"), imageFile("second.png")],
				text: initialText,
			},
			initialText.length
		);

		const snapshot = document.replaceText("[Image 2] then [Image 1]", 24);

		expect(snapshot.files).toEqual([
			imageFile("second.png"),
			imageFile("first.png"),
		]);
		expect(snapshot.fileTokens.map(({ token }) => token)).toEqual([
			"[Image 2]",
			"[Image 1]",
		]);
	});

	test("restoring a history composition recovers text, cursor, image order, and collapsed pasted text together", () => {
		const text = "explain [Image 2] then [Image 1] [Pasted ~4 lines]";
		const firstStart = text.indexOf("[Image 2]");
		const secondStart = text.indexOf("[Image 1]");
		const editor = createMemoryComposerEditor();
		const document = createComposerDocument(editor.adapter);

		const snapshot = document.restore(
			{
				fileTokens: [
					{ start: firstStart, token: "[Image 2]" },
					{ start: secondStart, token: "[Image 1]" },
				],
				files: [imageFile("second.png"), imageFile("first.png")],
				pastedText: [
					{ text: "one\ntwo\nthree\nfour", token: "[Pasted ~4 lines]" },
				],
				text,
			},
			12
		);

		expect(snapshot).toEqual({
			cursorOffset: 12,
			fileTokens: [
				{ start: firstStart, token: "[Image 2]" },
				{ start: secondStart, token: "[Image 1]" },
			],
			files: [imageFile("second.png"), imageFile("first.png")],
			pastedText: [
				{
					start: text.indexOf("[Pasted ~4 lines]"),
					text: "one\ntwo\nthree\nfour",
					token: "[Pasted ~4 lines]",
				},
			],
			text,
		});
	});

	test("submission capture drops invalid pasted markers instead of expanding lookalike text", () => {
		const token = "[Pasted ~3 lines]";
		const text = `${token} quoted ${token}`;
		const trackedStart = text.lastIndexOf(token);
		const editor = createMemoryComposerEditor();
		const document = createComposerDocument(editor.adapter);
		document.restore(
			{
				files: [],
				pastedText: [
					{ start: trackedStart, text: "actual\npayload\nlines", token },
				],
				text,
			},
			0
		);
		editor.editText(`${token} quoted gone`, 29);

		const snapshot = document.capture();
		expect(snapshot).toMatchObject({
			pastedText: [],
			text: `${token} quoted gone`,
		});
		expect(expandPastedText(snapshot.text, snapshot.pastedText)).toBe(
			snapshot.text
		);
	});
});

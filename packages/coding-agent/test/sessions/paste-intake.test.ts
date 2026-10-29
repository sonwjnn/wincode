import { describe, expect, test } from "bun:test";
import { decodePasteBytes, PasteEvent } from "@opentui/core";
import type { ClipboardImageResult } from "@/modules/sessions/clipboard-image";
import type { SessionFilePart } from "@/modules/sessions/message";
import { createComposerDocument } from "@/modules/sessions/ui/composer-document";
import {
	createPasteIntake,
	type PasteIntakeDependencies,
} from "@/modules/sessions/ui/paste-intake";
import { createMemoryComposerEditor } from "../support/composer-document-editor";

const imageFile = (index: number): SessionFilePart => ({
	filename: `image-${index}.png`,
	mediaType: "image/png",
	type: "file",
	url: `data:image/png;base64,image-${index}`,
});

const image = (): ClipboardImageResult => ({
	bytes: Uint8Array.from([1, 2, 3]),
	mimeType: "image/png",
});

const createHarness = (overrides: Partial<PasteIntakeDependencies> = {}) => {
	const editor = createMemoryComposerEditor();
	const document = createComposerDocument(editor.adapter);
	const errors: string[] = [];
	let documentChanges = 0;
	const dependencies: PasteIntakeDependencies = {
		active: true,
		applyTextPaste: (event) => {
			editor.adapter.insertText(decodePasteBytes(event.bytes));
			document.observeEditorChange();
		},
		document,
		onDocumentChange: () => {
			documentChanges += 1;
		},
		onError: (message) => {
			errors.push(message);
		},
		readClipboardImage: async () => ({ unavailable: true }),
		readImagePath: async () => ({ unavailable: true }),
		...overrides,
	};
	return {
		dependencies,
		document,
		documentChanges: () => documentChanges,
		editor,
		errors,
		intake: createPasteIntake(),
	};
};

const textPaste = (text: string) =>
	new PasteEvent(new TextEncoder().encode(text), { kind: "text" });

describe("Paste Intake", () => {
	test("binary image paste is staged before any path or clipboard fallback", async () => {
		let pathReads = 0;
		let clipboardReads = 0;
		const harness = createHarness({
			readClipboardImage: async () => {
				clipboardReads += 1;
				return image();
			},
			readImagePath: async () => {
				pathReads += 1;
				return image();
			},
		});
		const event = new PasteEvent(Uint8Array.from([8, 9]), {
			kind: "binary",
			mimeType: "image/png",
		});

		await harness.intake.handle(event, harness.dependencies);

		expect(event.defaultPrevented).toBe(true);
		expect(harness.document.capture().files).toHaveLength(1);
		expect(pathReads).toBe(0);
		expect(clipboardReads).toBe(0);
		expect(harness.documentChanges()).toBe(1);
	});

	test("a pasted image path becomes an attachment without reading clipboard image data", async () => {
		let clipboardReads = 0;
		const harness = createHarness({
			readImagePath: async () => image(),
			readClipboardImage: async () => {
				clipboardReads += 1;
				return image();
			},
		});

		await harness.intake.handle(
			textPaste("/tmp/diagram.png"),
			harness.dependencies
		);

		expect(harness.document.capture().files).toMatchObject([
			{ filename: "diagram.png", mediaType: "image/png" },
		]);
		expect(clipboardReads).toBe(0);
	});

	test("clipboard image fallback stages an attachment when pasted path intake is unavailable", async () => {
		const harness = createHarness({
			readClipboardImage: async () => image(),
		});

		await harness.intake.handle(
			textPaste("not-an-image-path"),
			harness.dependencies
		);

		expect(harness.document.capture().files).toMatchObject([
			{ filename: "clipboard", mediaType: "image/png" },
		]);
	});

	test("ordinary paste falls back to visible text when image intake is unavailable", async () => {
		const harness = createHarness();
		const event = textPaste("ordinary text");

		await harness.intake.handle(event, harness.dependencies);

		expect(event.defaultPrevented).toBe(true);
		expect(harness.document.capture().text).toBe("ordinary text");
		expect(harness.document.capture().pastedText).toEqual([]);
	});

	test("failed image readers preserve ordinary pasted text", async () => {
		const harness = createHarness({
			readClipboardImage: async () => {
				throw new Error("clipboard unavailable");
			},
			readImagePath: async () => {
				throw new Error("path unavailable");
			},
		});
		const event = textPaste("keep these words");

		await harness.intake.handle(event, harness.dependencies);

		expect(event.defaultPrevented).toBe(true);
		expect(harness.document.capture().text).toBe("keep these words");
	});

	test("long text paste stays collapsed in the document until submission", async () => {
		const harness = createHarness();
		const text = "first line\nsecond line\nthird line";

		await harness.intake.handle(textPaste(text), harness.dependencies);

		expect(harness.document.capture()).toMatchObject({
			pastedText: [{ text, token: "[Pasted ~3 lines]" }],
			text: "[Pasted ~3 lines] ",
		});
		expect(harness.documentChanges()).toBe(1);
	});

	test("image size refusal preserves the attachment error boundary", async () => {
		const harness = createHarness();
		const event = new PasteEvent(new Uint8Array(10 * 1024 * 1024 + 1), {
			kind: "binary",
			mimeType: "image/png",
		});

		await harness.intake.handle(event, harness.dependencies);

		expect(harness.errors).toEqual(["Images must be 10 MiB or smaller."]);
		expect(harness.document.capture().files).toEqual([]);
	});

	test("image count refusal leaves all five existing attachments untouched", async () => {
		const harness = createHarness();
		const text = Array.from(
			{ length: 5 },
			(_, index) => `[Image ${index + 1}]`
		).join(" ");
		const fileTokens = Array.from({ length: 5 }, (_, index) => ({
			start: text.indexOf(`[Image ${index + 1}]`),
			token: `[Image ${index + 1}]`,
		}));
		harness.document.restore(
			{
				fileTokens,
				files: Array.from({ length: 5 }, (_, index) => imageFile(index)),
				text,
			},
			text.length
		);

		await harness.intake.handle(
			new PasteEvent(Uint8Array.from([1]), {
				kind: "binary",
				mimeType: "image/png",
			}),
			harness.dependencies
		);

		expect(harness.errors).toEqual(["You can attach up to 5 images."]);
		expect(harness.document.capture().files).toHaveLength(5);
	});

	test("older async paste completion falls back to text after a newer image is staged", async () => {
		const imageRead = Promise.withResolvers<ClipboardImageResult>();
		const harness = createHarness({ readImagePath: () => imageRead.promise });
		const earlier = textPaste("/tmp/earlier.png");
		const earlierIntake = harness.intake.handle(earlier, harness.dependencies);

		await harness.intake.handle(
			new PasteEvent(Uint8Array.from([7]), {
				kind: "binary",
				mimeType: "image/png",
			}),
			harness.dependencies
		);
		imageRead.resolve(image());
		await earlierIntake;

		expect(harness.document.capture()).toMatchObject({
			files: [{ filename: "clipboard" }],
			text: "[Image 1] /tmp/earlier.png",
		});
	});

	test("disabled or inactive composers leave paste events for the active keyboard layer", async () => {
		const harness = createHarness({ active: false });
		const event = textPaste("leave this paste alone");

		await harness.intake.handle(event, harness.dependencies);

		expect(event.defaultPrevented).toBe(false);
		expect(harness.document.capture().text).toBe("");
	});
});

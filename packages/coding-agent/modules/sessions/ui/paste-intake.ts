import * as path from "node:path";
import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import type { SessionFilePart } from "@/modules/sessions/message";
import type { ClipboardImageResult } from "../clipboard-image";
import { summarizePastedText } from "../pasted-text";
import type { ComposerDocument } from "./composer-document";

const MAX_IMAGE_ATTACHMENTS = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const UNAVAILABLE_IMAGE = { unavailable: true } as const;

export type PasteIntakeDependencies = Readonly<{
	active: boolean;
	applyTextPaste: (event: PasteEvent) => void;
	document: ComposerDocument;
	onDocumentChange: () => void;
	onError: (message: string) => void;
	readClipboardImage: () => Promise<ClipboardImageResult>;
	readImagePath: (text: string) => Promise<ClipboardImageResult>;
}>;

export type PasteIntake = Readonly<{
	handle: (
		event: PasteEvent,
		dependencies: PasteIntakeDependencies
	) => Promise<void>;
}>;

const binaryImageMimeType = (event: PasteEvent): string | undefined => {
	const mimeType = event.metadata?.mimeType;
	return event.metadata?.kind === "binary" && mimeType?.startsWith("image/")
		? mimeType
		: undefined;
};

const insertImage = (
	bytes: Uint8Array,
	mediaType: string,
	filename: string,
	dependencies: PasteIntakeDependencies
): void => {
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		dependencies.onError("Images must be 10 MiB or smaller.");
		return;
	}
	const { document } = dependencies;
	if (document.capture().files.length >= MAX_IMAGE_ATTACHMENTS) {
		dependencies.onError(
			`You can attach up to ${MAX_IMAGE_ATTACHMENTS} images.`
		);
		return;
	}

	const file: SessionFilePart = {
		filename,
		mediaType,
		type: "file",
		url: `data:${mediaType};base64,${bytes.toBase64()}`,
	};
	document.insertImage(file);
	dependencies.onDocumentChange();
};

const insertPastedText = (
	text: string,
	dependencies: PasteIntakeDependencies
): boolean => {
	const summary = summarizePastedText(text);
	if (!summary) {
		return false;
	}
	dependencies.document.insertPastedText(summary);
	dependencies.onDocumentChange();
	return true;
};

const readPastedImageOrClipboard = async (
	text: string,
	dependencies: PasteIntakeDependencies
): Promise<{
	image: ClipboardImageResult;
	pathImage: ClipboardImageResult;
}> => {
	const pathImage = text
		? await dependencies.readImagePath(text)
		: UNAVAILABLE_IMAGE;
	const image =
		!text || "unavailable" in pathImage
			? await dependencies.readClipboardImage()
			: pathImage;
	return { image, pathImage };
};

const applyTextFallback = (
	event: PasteEvent,
	text: string,
	dependencies: PasteIntakeDependencies
): void => {
	if (!insertPastedText(text, dependencies)) {
		dependencies.applyTextPaste(event);
	}
};

export const createPasteIntake = (): PasteIntake => {
	let latestSequence = 0;

	const handle = async (
		event: PasteEvent,
		dependencies: PasteIntakeDependencies
	): Promise<void> => {
		if (!dependencies.active) {
			return;
		}

		const pasteSequence = ++latestSequence;
		const mediaType = binaryImageMimeType(event);
		if (mediaType) {
			event.preventDefault();
			insertImage(event.bytes, mediaType, "clipboard", dependencies);
			return;
		}

		event.preventDefault();
		const pastedText = decodePasteBytes(event.bytes);
		try {
			const { image, pathImage } = await readPastedImageOrClipboard(
				pastedText,
				dependencies
			);
			if (pasteSequence !== latestSequence) {
				dependencies.applyTextPaste(event);
				return;
			}
			if ("unavailable" in image) {
				applyTextFallback(event, pastedText, dependencies);
				return;
			}

			insertImage(
				image.bytes,
				image.mimeType,
				"unavailable" in pathImage ? "clipboard" : path.basename(pastedText),
				dependencies
			);
		} catch {
			dependencies.applyTextPaste(event);
		}
	};

	return { handle };
};

import type {
	ClipboardImageMimeType,
	ClipboardReader,
} from "@/shared/clipboard/clipboard";

export type ClipboardImage = {
	bytes: Uint8Array;
	mediaType: ClipboardImageMimeType;
};

export type ClipboardImageResult = ClipboardImage | { unavailable: true };

const unavailable = (): ClipboardImageResult => ({ unavailable: true });
const QUOTED_PATH = /^(?:'([^']*)'|"((?:\\.|[^"\\])*)")$/;
const ESCAPED_PATH_CHARACTER = /\\([\\ ])/g;
const ESCAPED_QUOTE_CHARACTER = /\\(.)/g;

export function imageFromBytes(bytes: Uint8Array): ClipboardImageResult {
	if (
		bytes.length >= 8 &&
		bytes
			.slice(0, 8)
			.every(
				(value, index) =>
					value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]
			)
	) {
		return { bytes, mediaType: "image/png" };
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return { bytes, mediaType: "image/jpeg" };
	}
	if (
		bytes.length >= 6 &&
		new TextDecoder().decode(bytes.slice(0, 6)) === "GIF8"
	) {
		return { bytes, mediaType: "image/gif" };
	}
	if (
		bytes.length >= 12 &&
		new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
		new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
	) {
		return { bytes, mediaType: "image/webp" };
	}
	return unavailable();
}

export function decodeImagePath(text: string): string | null {
	const value = text.trim();
	if (!value || value.includes("\n")) {
		return null;
	}
	const unquoted = value.replace(
		QUOTED_PATH,
		(_, single, double) =>
			single ?? double.replaceAll(ESCAPED_QUOTE_CHARACTER, "$1")
	);
	if (unquoted.startsWith("file://")) {
		try {
			const url = new URL(unquoted);
			if (url.protocol !== "file:" || url.hostname) {
				return null;
			}
			return decodeURIComponent(url.pathname);
		} catch {
			return null;
		}
	}
	const path = unquoted.replaceAll(ESCAPED_PATH_CHARACTER, "$1");
	return path.startsWith("/") ||
		path.startsWith("./") ||
		path.startsWith("../") ||
		path.startsWith("~/")
		? path
		: null;
}

export type ImagePathDeps = {
	readFile: (path: string) => Promise<Uint8Array>;
	stat?: (path: string) => Promise<{ isFile: () => boolean }>;
};

export async function readImagePath(
	text: string,
	deps: ImagePathDeps
): Promise<ClipboardImageResult> {
	const path = decodeImagePath(text);
	if (!(path && deps.stat)) {
		return unavailable();
	}
	try {
		if (!(await deps.stat(path)).isFile()) {
			return unavailable();
		}
		return imageFromBytes(await deps.readFile(path));
	} catch {
		return unavailable();
	}
}

export async function readClipboardImage(
	clipboard: ClipboardReader
): Promise<ClipboardImageResult> {
	try {
		const content = await clipboard.read();
		return content === undefined
			? unavailable()
			: imageFromBytes(content.bytes);
	} catch {
		return unavailable();
	}
}

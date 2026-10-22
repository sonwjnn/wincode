import {
	type ClipboardService,
	type ClipboardWriteResult,
	createClipboard,
	createHostClipboard,
	createRendererClipboardAdapter,
	type HostClipboardService,
	type RendererClipboardBoundary,
} from "@opentui/core";
import { getErrorMessage, logger } from "@wincode/utils";

export type ClipboardContent = Readonly<{
	bytes: Uint8Array;
}>;

export type TuiClipboard = Readonly<{
	read: () => Promise<ClipboardContent | undefined>;
	write: (text: string) => Promise<void>;
	dispose: () => Promise<void>;
}>;

export type ClipboardWriter = Pick<TuiClipboard, "write">;
export type ClipboardReader = Pick<TuiClipboard, "read">;

/** Raised when the text exceeds the clipboard service's UTF-8 write budget. */
export class ClipboardTooLargeError extends Error {
	constructor(options?: ErrorOptions) {
		super("Selection is too large to copy.", options);
		this.name = "ClipboardTooLargeError";
	}
}

export type ClipboardServiceLike = Pick<
	ClipboardService,
	"read" | "writeText" | "dispose"
>;

export const CLIPBOARD_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

export type ClipboardImageMimeType =
	(typeof CLIPBOARD_IMAGE_MIME_TYPES)[number];

const unsupportedHost: HostClipboardService = {
	maxWriteBytes: 0,
	read: async () => ({ status: "unsupported" }),
	writeText: async () => ({ status: "unsupported" }),
	clear: async () => ({ status: "unsupported" }),
	dispose: async () => undefined,
};

const createAvailableHostClipboard = (): HostClipboardService => {
	try {
		return createHostClipboard();
	} catch (error) {
		void logger.warn("Native clipboard unavailable; falling back to OSC52.", {
			error: getErrorMessage(error, "Unknown clipboard error."),
		});
		return unsupportedHost;
	}
};

/**
 * OpenTUI rejects NUL characters and unpaired UTF-16 surrogates. Strip NUL and
 * replace a split surrogate pair with the replacement character so a cell
 * selection that bisects an emoji still copies.
 */
const sanitizeClipboardText = (text: string): string =>
	Array.from(text, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 0) {
			return "";
		}
		return codePoint >= 0xd8_00 && codePoint <= 0xdf_ff ? "\uFFFD" : character;
	}).join("");

const writeSucceeded = (result: ClipboardWriteResult): boolean =>
	result.host.status === "written" || result.terminal.status === "attempted";

export function createClipboardAdapter(
	clipboard: ClipboardServiceLike
): TuiClipboard {
	return {
		async read() {
			const result = await clipboard.read({
				preferredTypes: CLIPBOARD_IMAGE_MIME_TYPES,
				selection: "clipboard",
			});
			if (result.status !== "read") {
				return;
			}
			return { bytes: result.representation.bytes };
		},
		async write(text) {
			const sanitized = sanitizeClipboardText(text);
			if (sanitized.length === 0) {
				return;
			}
			let result: ClipboardWriteResult;
			try {
				// allowRemoteHost is intentionally not exposed: OpenTUI's default keeps
				// the host clipboard untouched over SSH, where it belongs to the remote machine.
				result = await clipboard.writeText(sanitized, {
					destination: "all-available",
					selection: "clipboard",
				});
			} catch (error) {
				if (error instanceof RangeError) {
					throw new ClipboardTooLargeError({ cause: error });
				}
				throw error;
			}
			if (writeSucceeded(result)) {
				return;
			}
			if (result.host.status === "failed") {
				throw result.host.error;
			}
			throw new Error(
				`Clipboard write failed (host: ${result.host.status}, terminal: ${result.terminal.status})`
			);
		},
		dispose: () => clipboard.dispose(),
	};
}

export function createTuiClipboard(
	renderer: RendererClipboardBoundary
): TuiClipboard {
	return createClipboardAdapter(
		createClipboard({
			host: createAvailableHostClipboard(),
			terminal: createRendererClipboardAdapter(renderer),
		})
	);
}

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
	mimeType: ClipboardImageMimeType;
}>;

export type ClipboardWriteOutcome = "copied" | "empty";

export type TuiClipboard = Readonly<{
	read: () => Promise<ClipboardContent | undefined>;
	write: (text: string) => Promise<ClipboardWriteOutcome>;
	dispose: () => Promise<void>;
}>;

export type ClipboardWriter = Pick<TuiClipboard, "write">;
export type ClipboardReader = Pick<TuiClipboard, "read">;

/** Raised when the text exceeds the clipboard service's UTF-8 write budget. */
export class ClipboardTooLargeError extends Error {
	constructor(options?: ErrorOptions) {
		super("Clipboard payload exceeds the write limit.", options);
		this.name = "ClipboardTooLargeError";
	}
}

/** Port used by the adapter tests and by the clipboard factory. */
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

const isClipboardImageMimeType = (
	value: string
): value is ClipboardImageMimeType =>
	(CLIPBOARD_IMAGE_MIME_TYPES as readonly string[]).includes(value);

// The fallback only writes to the terminal; accept OpenTUI's u32 ceiling.
const CLIPBOARD_WRITE_BUDGET_BYTES = 0xff_ff_ff_ff;
const CLIPBOARD_HOST_READ_BUDGET_BYTES = 16 * 1024 * 1024;
const CLIPBOARD_HOST_TIMEOUT_MS = 5000;

/** Fallback host used when the native clipboard service cannot initialize. */
export const UNSUPPORTED_HOST_CLIPBOARD: HostClipboardService = {
	// Use OpenTUI's u32 ceiling so validation does not reject text before the
	// terminal fallback gets a chance to copy it.
	maxWriteBytes: CLIPBOARD_WRITE_BUDGET_BYTES,
	read: async () => ({ status: "unsupported" }),
	writeText: async () => ({ status: "unsupported" }),
	clear: async () => ({ status: "unsupported" }),
	dispose: async () => undefined,
};

const createAvailableHostClipboard = (): HostClipboardService => {
	try {
		return createHostClipboard({
			maxReadBytes: CLIPBOARD_HOST_READ_BUDGET_BYTES,
			timeoutMs: CLIPBOARD_HOST_TIMEOUT_MS,
		});
	} catch (error) {
		void logger.warn("Native clipboard unavailable; falling back to OSC52.", {
			error: getErrorMessage(error, "Unknown clipboard error."),
		});
		return UNSUPPORTED_HOST_CLIPBOARD;
	}
};

/**
 * OpenTUI rejects NUL characters and unpaired UTF-16 surrogates. Strip NUL and
 * repair split surrogate pairs so a cell selection that bisects an emoji still
 * copies.
 */
const sanitizeClipboardText = (text: string): string =>
	text.replaceAll("\0", "").toWellFormed();

const isWriteLimitError = (error: unknown): boolean =>
	error instanceof RangeError && error.message.includes("byte limit");

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
			if (result.status === "limit-exceeded") {
				void logger.warn(
					"Clipboard image exceeds the read budget; falling back to text."
				);
			}
			if (result.status !== "read") {
				return;
			}
			const mimeType = result.representation.mimeType;
			if (!isClipboardImageMimeType(mimeType)) {
				return;
			}
			return {
				bytes: result.representation.bytes,
				mimeType,
			};
		},
		async write(text) {
			const sanitized = sanitizeClipboardText(text);
			if (sanitized.length === 0) {
				return "empty";
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
				if (isWriteLimitError(error)) {
					throw new ClipboardTooLargeError({ cause: error });
				}
				throw error;
			}
			if (writeSucceeded(result)) {
				return "copied";
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

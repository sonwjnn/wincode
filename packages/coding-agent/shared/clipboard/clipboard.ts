import {
	type ClipboardService,
	type ClipboardWriteResult,
	createClipboard,
	createHostClipboard,
	createRendererClipboardAdapter,
	type RendererClipboardBoundary,
} from "@opentui/core";

export type ClipboardContent = Readonly<{
	bytes: Uint8Array;
	mimeType: string;
}>;

export type TuiClipboard = Readonly<{
	read: () => Promise<ClipboardContent | undefined>;
	write: (text: string) => Promise<void>;
	dispose: () => Promise<void>;
}>;

export type ClipboardWriter = Pick<TuiClipboard, "write">;
export type ClipboardReader = Pick<TuiClipboard, "read">;
export type ClipboardFactory = (
	renderer: RendererClipboardBoundary
) => TuiClipboard;

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

export type ClipboardComponents = Readonly<{
	createClipboard: typeof createClipboard;
	createHostClipboard: typeof createHostClipboard;
	createRendererClipboardAdapter: typeof createRendererClipboardAdapter;
}>;

const nativeClipboardComponents: ClipboardComponents = {
	createClipboard,
	createHostClipboard,
	createRendererClipboardAdapter,
};

export const CLIPBOARD_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

export type ClipboardImageMimeType =
	(typeof CLIPBOARD_IMAGE_MIME_TYPES)[number];

const PREFERRED_READ_TYPES = CLIPBOARD_IMAGE_MIME_TYPES;

const writeSucceeded = (result: ClipboardWriteResult): boolean =>
	result.host.status === "written" || result.terminal.status === "attempted";

export function createClipboardAdapter(
	clipboard: ClipboardServiceLike
): TuiClipboard {
	return {
		async read() {
			const result = await clipboard.read({
				preferredTypes: PREFERRED_READ_TYPES,
				selection: "clipboard",
			});
			if (result.status !== "read") {
				return;
			}
			return {
				bytes: result.representation.bytes,
				mimeType: result.representation.mimeType,
			};
		},
		async write(text) {
			// OpenTUI rejects NUL before any destination; clipboard text cannot contain it.
			const sanitized = text.replaceAll("\0", "");
			if (sanitized.length === 0) {
				return;
			}
			let result: ClipboardWriteResult;
			try {
				// allowRemoteHost stays false: over SSH the host clipboard belongs to the remote machine.
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
	renderer: RendererClipboardBoundary,
	components: ClipboardComponents = nativeClipboardComponents
): TuiClipboard {
	return createClipboardAdapter(
		components.createClipboard({
			host: components.createHostClipboard(),
			terminal: components.createRendererClipboardAdapter(renderer),
		})
	);
}

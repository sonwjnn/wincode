import { describe, expect, test } from "bun:test";
import type {
	ClipboardReadOptions,
	ClipboardReadResult,
	ClipboardWriteOptions,
	ClipboardWriteResult,
} from "@opentui/core";
import {
	type ClipboardServiceLike,
	ClipboardTooLargeError,
	createClipboardAdapter,
} from "@/shared/clipboard/clipboard";

const notAttemptedTerminal = {
	status: "not-attempted",
	capability: "unknown",
} as const;

const hostWritten = (): ClipboardWriteResult => ({
	host: { status: "written" },
	terminal: notAttemptedTerminal,
});

const coreClipboard = (options: {
	read?: (input: ClipboardReadOptions) => Promise<ClipboardReadResult>;
	writeText?: (
		text: string,
		input: ClipboardWriteOptions
	) => Promise<ClipboardWriteResult>;
	dispose?: () => Promise<void>;
}): ClipboardServiceLike => ({
	read: options.read ?? (async () => ({ status: "empty" })),
	writeText: options.writeText ?? (async () => hostWritten()),
	dispose: options.dispose ?? (async () => undefined),
});

describe("createClipboardAdapter", () => {
	test("reads image bytes from the clipboard with every supported MIME type", async () => {
		const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
		let readOptions: ClipboardReadOptions | undefined;
		const reader = createClipboardAdapter(
			coreClipboard({
				read: async (input) => {
					readOptions = input;
					return {
						status: "read",
						representation: { bytes, mimeType: "image/png" },
					};
				},
			})
		);

		await expect(reader.read()).resolves.toEqual({
			bytes,
			mimeType: "image/png",
		});
		expect(readOptions).toEqual({
			preferredTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
			selection: "clipboard",
		});
	});

	test("returns no content when the clipboard has no accepted image type", async () => {
		const reader = createClipboardAdapter(
			coreClipboard({ read: async () => ({ status: "empty" }) })
		);

		await expect(reader.read()).resolves.toBeUndefined();
	});

	test("returns no content when the platform cannot read images", async () => {
		const reader = createClipboardAdapter(
			coreClipboard({ read: async () => ({ status: "unsupported" }) })
		);

		await expect(reader.read()).resolves.toBeUndefined();
	});

	test("returns no content instead of throwing when a read fails", async () => {
		const reader = createClipboardAdapter(
			coreClipboard({
				read: async () => ({
					status: "failed",
					error: new Error("pasteboard busy"),
				}),
			})
		);

		await expect(reader.read()).resolves.toBeUndefined();
	});

	test("writes both the host and terminal so local and tmux clipboards stay in sync", async () => {
		const writes: { text: string; input: ClipboardWriteOptions }[] = [];
		const writer = createClipboardAdapter(
			coreClipboard({
				writeText: async (text, input) => {
					writes.push({ input, text });
					return hostWritten();
				},
			})
		);

		await writer.write("hello");

		expect(writes).toEqual([
			{
				input: { destination: "all-available", selection: "clipboard" },
				text: "hello",
			},
		]);
	});

	test("treats a terminal OSC52 attempt as success when the host is unavailable", async () => {
		const writer = createClipboardAdapter(
			coreClipboard({
				writeText: async () => ({
					host: { status: "unsupported" },
					terminal: { status: "attempted", capability: "supported" },
				}),
			})
		);

		await writer.write("hello");
	});

	test("surfaces the host failure instead of reporting a successful copy", async () => {
		const failure = new Error("pasteboard busy");
		const writer = createClipboardAdapter(
			coreClipboard({
				writeText: async () => ({
					host: { status: "failed", error: failure },
					terminal: notAttemptedTerminal,
				}),
			})
		);

		await expect(writer.write("hello")).rejects.toBe(failure);
	});

	test("rejects when neither the host nor the terminal accepted the text", async () => {
		const writer = createClipboardAdapter(
			coreClipboard({
				writeText: async () => ({
					host: { status: "not-attempted" },
					terminal: { status: "local-failure", capability: "unsupported" },
				}),
			})
		);

		await expect(writer.write("hello")).rejects.toThrow(
			"Clipboard write failed (host: not-attempted, terminal: local-failure)"
		);
	});

	test("strips NUL characters that OpenTUI would reject before any write", async () => {
		let written = "";
		const writer = createClipboardAdapter(
			coreClipboard({
				writeText: async (text) => {
					written = text;
					return hostWritten();
				},
			})
		);

		await writer.write("a\0b\0c");

		expect(written).toBe("abc");
	});

	test("does not call the clipboard service for empty text", async () => {
		let writes = 0;
		const writer = createClipboardAdapter(
			coreClipboard({
				writeText: async () => {
					writes += 1;
					return hostWritten();
				},
			})
		);

		await writer.write("");

		expect(writes).toBe(0);
	});

	test("maps the UTF-8 size limit to a selection-specific error", async () => {
		const writer = createClipboardAdapter(
			coreClipboard({
				writeText: async () => {
					throw new RangeError("writeText exceeds the configured limit");
				},
			})
		);

		await expect(writer.write("hello")).rejects.toBeInstanceOf(
			ClipboardTooLargeError
		);
	});

	test("dispose releases the underlying clipboard service", async () => {
		let disposed = 0;
		const writer = createClipboardAdapter(
			coreClipboard({
				dispose: async () => {
					disposed += 1;
				},
			})
		);

		await writer.dispose();

		expect(disposed).toBe(1);
	});
});

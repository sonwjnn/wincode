import { describe, expect, test } from "bun:test";
import {
	decodeImagePath,
	readClipboardImage,
	readImagePath,
} from "@/modules/sessions/clipboard-image";

describe("readClipboardImage", () => {
	test("reads actual image bytes from a pasted filepath", async () => {
		const icon = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1,
		]);
		const result = await readImagePath('"/tmp/My\\ File.png"', {
			readFile: async () => icon,
			stat: async () => ({ isFile: () => true }),
		});
		expect(result).toEqual({ bytes: icon, mediaType: "image/png" });
		expect(decodeImagePath("notes.txt")).toBeNull();
	});

	test("does not read ordinary text or non-image files", async () => {
		let reads = 0;
		const result = await readImagePath("/tmp/notes.txt", {
			readFile: async () => {
				reads += 1;
				return new Uint8Array();
			},
			stat: async () => ({ isFile: () => true }),
		});
		expect(result).toEqual({ unavailable: true });
		expect(reads).toBe(1);
	});

	test("returns image bytes from the clipboard service", async () => {
		const bytes = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const result = await readClipboardImage({
			read: async () => ({ bytes, mimeType: "image/png" }),
		});
		expect(result).toEqual({ bytes, mediaType: "image/png" });
	});

	test("reports unavailable when the clipboard holds no image", async () => {
		const result = await readClipboardImage({
			read: async () => undefined,
		});
		expect(result).toEqual({ unavailable: true });
	});

	test("returns the MIME type reported by the clipboard service", async () => {
		const bytes = new TextEncoder().encode("image data");
		const result = await readClipboardImage({
			read: async () => ({ bytes, mimeType: "image/webp" }),
		});
		expect(result).toEqual({ bytes, mediaType: "image/webp" });
	});

	test("reports unavailable instead of failing the paste when the read throws", async () => {
		const result = await readClipboardImage({
			read: async () => {
				throw new Error("pasteboard busy");
			},
		});
		expect(result).toEqual({ unavailable: true });
	});
});

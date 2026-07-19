import { describe, expect, test } from "bun:test";
import {
	type ClipboardImageDeps,
	decodeImagePath,
	readClipboardImage,
	readImagePath,
} from "./clipboard-image";

const deps = (
	overrides: Partial<ClipboardImageDeps> = {}
): ClipboardImageDeps => ({
	platform: "linux",
	environment: {},
	run: async () => ({ exitCode: 1, stdout: new Uint8Array() }),
	readFile: async () => new Uint8Array(),
	removeFile: async () => undefined,
	temporaryPath: () => "/tmp/clipboard.png",
	...overrides,
});

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

	test("reads Wayland PNG bytes", async () => {
		const bytes = Uint8Array.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		const result = await readClipboardImage(
			deps({ run: async () => ({ exitCode: 0, stdout: bytes }) })
		);
		expect(result).toEqual({ bytes, mediaType: "image/png" });
	});

	test("falls back to X11 and reports unavailable for text", async () => {
		const commands: string[] = [];
		const result = await readClipboardImage(
			deps({
				run: async (command) => {
					commands.push(command);
					return {
						exitCode: command === "xclip" ? 0 : 1,
						stdout: new TextEncoder().encode("text"),
					};
				},
			})
		);
		expect(commands).toEqual(["wl-paste", "xclip"]);
		expect(result).toEqual({ unavailable: true });
	});
});

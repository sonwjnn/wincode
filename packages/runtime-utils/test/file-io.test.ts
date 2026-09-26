import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeUtf8, readUtf8File } from "../src/file-io";

test("preserves UTF-8 BOM and replacement decoding in file contents", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-utils-file-io-"));
	try {
		const path = join(directory, "input.txt");
		const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0xff);
		await globalThis.Bun.write(path, bytes);

		expect(decodeUtf8(bytes)).toBe("\uFEFFa\uFFFD");
		expect(await readUtf8File(path)).toBe("\uFEFFa\uFFFD");
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

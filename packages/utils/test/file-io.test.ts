import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decodeUtf8, readUtf8File } from "../src/file-io";

test("preserves UTF-8 BOM and replacement decoding in file contents", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "utils-file-io-"));
	try {
		const inputPath = path.join(directory, "input.txt");
		const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0xff);
		await Bun.write(inputPath, bytes);

		expect(decodeUtf8(bytes)).toBe("\uFEFFa\uFFFD");
		expect(await readUtf8File(inputPath)).toBe("\uFEFFa\uFFFD");
	} finally {
		await fs.rm(directory, { force: true, recursive: true });
	}
});

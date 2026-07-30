import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("theme consumers", () => {
	test("floating overlays use menu background", async () => {
		const [dialogSource, toastSource] = await Promise.all([
			readFile(
				new URL("../dialog/dialog-provider.tsx", import.meta.url),
				"utf8"
			),
			readFile(new URL("../toast/toast-provider.tsx", import.meta.url), "utf8"),
		]);

		expect(dialogSource).toContain("backgroundColor={colors.backgroundMenu}");
		expect(toastSource).toContain("backgroundColor={colors.backgroundMenu}");
	});
});

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("dialog provider", () => {
	test("exposes closeAll and clears the full stack", async () => {
		const source = await readFile(
			new URL("./dialog-provider.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain("closeAll");
		expect(source).toContain("dialogStackRef.current = []");
		expect(source).toContain(
			"for (let index = currentStack.length - 1; index >= 0; index -= 1)"
		);
		expect(source).toContain("layerId)");
	});

	test("close still pops only top layer", async () => {
		const source = await readFile(
			new URL("./dialog-provider.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain("const topId = layerIdsRef.current.at(-1);");
		expect(source).toContain("prev.slice(0, -1)");
	});

	test("only top dialog dims and closes on backdrop", async () => {
		const source = await readFile(
			new URL("./dialog-provider.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain(
			"const backdropColor = isTop ? RGBA.fromInts(0, 0, 0, 150) : undefined;"
		);
		expect(source).toContain("backgroundColor={backdropColor}");
		expect(source).toContain("onMouseDown={isTop ? () => close() : undefined}");
		expect(source).toContain("const defaultWidth =");
		expect(source).toContain("const width =");
		expect(source).toContain("config.width === undefined");
		expect(source).toContain("Math.floor(dimensions.width * 0.67)");
		expect(source).toContain("Math.min(100, dimensions.width - 2)");
	});

	test("dialog surface uses menu background", async () => {
		const source = await readFile(
			new URL("./dialog-provider.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain("backgroundColor={colors.backgroundMenu}");
		expect(source).not.toContain("colors.dialogSurface");
	});
});

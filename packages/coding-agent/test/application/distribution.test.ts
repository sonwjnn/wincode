import { expect, test } from "bun:test";

test("Coding-Agent's workspace manifest declares wincode and resolves both default Plugins", async () => {
	const manifest = (await Bun.file(
		new URL("../../package.json", import.meta.url)
	).json()) as {
		bin: Readonly<Record<string, string>>;
		dependencies: Readonly<Record<string, string>>;
	};

	expect(manifest.bin.wincode).toBe("./bin/wincode.ts");
	for (const specifier of ["@wincode/mcp", "@wincode/subagents"]) {
		expect(manifest.dependencies[specifier]).toBe("workspace:*");
		expect(import.meta.resolve(`${specifier}/plugin`)).toBeString();
	}
});

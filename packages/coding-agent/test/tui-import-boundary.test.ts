import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

test("Biome blocks direct OpenTUI imports but accepts the shared TUI facade", async () => {
	const temporaryDirectory = await fs.mkdtemp(
		path.join(import.meta.dir, "tui-import-boundary-")
	);
	const probePath = path.join(temporaryDirectory, "probe.ts");
	const repositoryRoot = path.resolve(import.meta.dir, "../../../");
	const lintProbe = async (moduleName: string) => {
		await Bun.write(
			probePath,
			`import { createCliRenderer } from "${moduleName}";\nvoid createCliRenderer;\n`
		);
		return await $`bunx biome lint ${probePath} 2>&1`
			.cwd(repositoryRoot)
			.quiet()
			.nothrow();
	};

	try {
		const directImport = await lintProbe("@opentui/core");
		expect(directImport.exitCode).not.toBe(0);
		expect(directImport.text()).toContain("lint/style/noRestrictedImports");

		const publicImport = await lintProbe("@wincode/tui/core");
		expect(publicImport.exitCode).toBe(0);
	} finally {
		await fs.rm(temporaryDirectory, { force: true, recursive: true });
	}
});

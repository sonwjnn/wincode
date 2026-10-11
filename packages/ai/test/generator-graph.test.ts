import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "bun";

const SCRIPTS_DIR = path.join(import.meta.dir, "../scripts");
const ENTRIES = [
	path.join(SCRIPTS_DIR, "sync-model-metadata.ts"),
	path.join(SCRIPTS_DIR, "metadata-model.ts"),
];
const GENERATED_IMPORT = /model-metadata\.generated/;
const CONVERTER_IMPORT = /models-dev(?:\.ts)?$/;

describe("model metadata generator import graph", () => {
	test("bundles the converter without bundling generated output (#57)", async () => {
		const outputDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-generator-graph-")
		);
		let resolvedConverter = false;
		try {
			const result = await build({
				entrypoints: ENTRIES,
				outdir: outputDir,
				plugins: [
					{
						name: "reject-generated-model-metadata",
						setup(build) {
							build.onResolve({ filter: GENERATED_IMPORT }, ({ path }) => {
								throw new Error(
									`Generator unexpectedly imports generated output: ${path}`
								);
							});
							build.onResolve({ filter: CONVERTER_IMPORT }, () => {
								resolvedConverter = true;
								return;
							});
						},
					},
				],
				target: "bun",
			});

			expect(result.success).toBe(true);
			expect(resolvedConverter).toBe(true);
		} finally {
			await fs.rm(outputDir, { force: true, recursive: true });
		}
	});
});

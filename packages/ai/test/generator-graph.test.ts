import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "bun";

const SCRIPTS_DIR = join(import.meta.dir, "../scripts");
const ENTRIES = [
	join(SCRIPTS_DIR, "sync-model-metadata.ts"),
	join(SCRIPTS_DIR, "metadata-model.ts"),
];
const GENERATED_IMPORT = /model-metadata\.generated/;
const CONVERTER_IMPORT = /models-dev(?:\.ts)?$/;

describe("model metadata generator import graph", () => {
	test("bundles the converter without bundling generated output (#57)", async () => {
		const outputDir = await mkdtemp(join(tmpdir(), "wincode-generator-graph-"));
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
			await rm(outputDir, { force: true, recursive: true });
		}
	});
});

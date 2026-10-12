import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const AI_ROOT = path.join(import.meta.dir, "..");
const FULL_MODEL_CATALOG = /\/(?:catalog|model-metadata(?:\.generated)?)\.ts$/u;
const SDK_PROVIDER_MODULE = /\/sdk-providers\//u;
const OPENROUTER_MODEL_CATALOG = /\/openrouter-(?:models|catalog)(?:\.ts)?$/u;

type BundleMetadata = Readonly<{ inputs: Readonly<Record<string, unknown>> }>;

const bundledInputsFor = async (
	entrypoint: string
): Promise<readonly string[]> => {
	const outputDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "wincode-sdk-provider-graph-")
	);
	const metadataPath = path.join(outputDir, "meta.json");
	try {
		const result =
			await $`${process.execPath} build ${entrypoint} --target=bun --outdir=${outputDir} --metafile=${metadataPath}`
				.cwd(path.join(AI_ROOT, "..", ".."))
				.quiet()
				.nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`Provider import graph bundle failed: ${result.text()}`);
		}
		const metadata = (await Bun.file(metadataPath).json()) as BundleMetadata;
		return Object.keys(metadata.inputs).map((inputPath) =>
			inputPath.replaceAll("\\", "/")
		);
	} finally {
		await fs.rm(outputDir, { force: true, recursive: true });
	}
};

describe("SDK provider import graphs", () => {
	test("public SDK core does not bundle built-in providers, catalog, or generated metadata", async () => {
		const inputs = await bundledInputsFor(path.join(AI_ROOT, "src/sdk.ts"));
		expect(
			inputs.some((inputPath) => SDK_PROVIDER_MODULE.test(inputPath))
		).toBe(false);
		expect(inputs.some((inputPath) => FULL_MODEL_CATALOG.test(inputPath))).toBe(
			false
		);
	});

	test("DeepSeek and OpenRouter imports stay independent of peer providers and bundled model catalogs", async () => {
		for (const providerId of ["deepseek", "openrouter"]) {
			const inputs = await bundledInputsFor(
				path.join(AI_ROOT, `src/sdk-providers/${providerId}.ts`)
			);
			expect(
				inputs.some(
					(inputPath) =>
						SDK_PROVIDER_MODULE.test(inputPath) &&
						!inputPath.endsWith(`/sdk-providers/${providerId}.ts`)
				)
			).toBe(false);
			expect(
				inputs.some((inputPath) => FULL_MODEL_CATALOG.test(inputPath))
			).toBe(false);
			expect(
				inputs.some((inputPath) => OPENROUTER_MODEL_CATALOG.test(inputPath))
			).toBe(false);
		}
	});
});

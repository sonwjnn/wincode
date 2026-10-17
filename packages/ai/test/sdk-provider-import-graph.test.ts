import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const AI_ROOT = path.join(import.meta.dir, "..");
const OBSOLETE_MODEL_POLICY =
	/\/(?:catalog\.ts|generated\/model-metadata\.generated\.ts)$/u;
const SDK_PROVIDER_MODULE = /\/sdk-providers\//u;
const OPENROUTER_MODEL_SOURCE = /\/openrouter-models(?:\.ts)?$/u;
const LEGACY_MODEL_IMPLEMENTATION =
	/\/model-client\/|\/(?:model-target|model-provider-options)\.ts$/u;

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
	test("package exports omit legacy Connections and Catalog surfaces", async () => {
		const packageManifest = (await Bun.file(
			path.join(AI_ROOT, "package.json")
		).json()) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;
		const exportNames = Object.keys(packageManifest.exports);

		expect(exportNames).toContain(".");
		expect(packageManifest.exports["."]).toEqual({
			default: "./src/index.ts",
		});
		expect(exportNames).not.toContain("./model");
		expect(exportNames).not.toContain("./model-client");
		expect(exportNames).not.toContain("./model-target");
		expect(exportNames).not.toContain("./model-provider-options");
		expect(exportNames).not.toContain("./connections");
		expect(exportNames).not.toContain("./models");
		expect(exportNames).not.toContain("./models-dev");
		expect(exportNames).not.toContain("./catalog");
		expect(exportNames).not.toContain("./connections/legacy-cleanup");
	});

	test("public SDK core does not bundle built-in providers or obsolete model-policy metadata", async () => {
		const inputs = await bundledInputsFor(path.join(AI_ROOT, "src/sdk.ts"));
		expect(
			inputs.some((inputPath) => SDK_PROVIDER_MODULE.test(inputPath))
		).toBe(false);
		expect(
			inputs.some((inputPath) => OBSOLETE_MODEL_POLICY.test(inputPath))
		).toBe(false);
	});

	test("built-in providers bundle their static model baseline without the removed ModelClient path", async () => {
		for (const providerId of [
			"anthropic",
			"deepseek",
			"google",
			"openai",
			"opencode-go",
			"openrouter",
		]) {
			const inputs = await bundledInputsFor(
				path.join(AI_ROOT, `src/sdk-providers/${providerId}.ts`)
			);
			expect(
				inputs.some((inputPath) => LEGACY_MODEL_IMPLEMENTATION.test(inputPath))
			).toBe(false);
			if (providerId !== "openrouter") {
				expect(
					inputs.some((inputPath) =>
						inputPath.endsWith(`generated/${providerId}.generated.ts`)
					)
				).toBe(true);
			}
		}
	});

	test("DeepSeek and OpenRouter imports stay independent of peer providers and model sources", async () => {
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
				inputs.some((inputPath) => OBSOLETE_MODEL_POLICY.test(inputPath))
			).toBe(false);
			expect(
				inputs.some((inputPath) => OPENROUTER_MODEL_SOURCE.test(inputPath))
			).toBe(false);
		}
	});

	test("Google and OpenCode Go bundle their enriched provider-owned models without metadata shards", async () => {
		for (const providerId of ["google", "opencode-go"]) {
			const inputs = await bundledInputsFor(
				path.join(AI_ROOT, `src/sdk-providers/${providerId}.ts`)
			);
			expect(
				inputs
					.filter((inputPath) => SDK_PROVIDER_MODULE.test(inputPath))
					.map((inputPath) => path.basename(inputPath))
					.toSorted()
			).toEqual([`${providerId}.ts`]);
			expect(
				inputs.some((inputPath) => OBSOLETE_MODEL_POLICY.test(inputPath))
			).toBe(false);
			expect(
				inputs.some(
					(inputPath) =>
						inputPath.includes("generated/") &&
						inputPath.includes("model-metadata.generated.ts")
				)
			).toBe(false);
			expect(
				inputs.some((inputPath) =>
					inputPath.endsWith(`generated/${providerId}.generated.ts`)
				)
			).toBe(true);
		}
	});
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const AI_ROOT = path.join(import.meta.dir, "..");
const FULL_MODEL_CATALOG = /\/(?:catalog|model-metadata(?:\.generated)?)\.ts$/u;
const SDK_PROVIDER_MODULE = /\/sdk-providers\//u;
const OPENROUTER_MODEL_CATALOG = /\/openrouter-(?:models|catalog)(?:\.ts)?$/u;
const ANTHROPIC_MODEL_ARTIFACT =
	/(?:^|\/)anthropic-model-metadata(?:\.generated)?\.ts$/u;

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

	test("Google and OpenCode Go provider imports bundle only their own model and metadata artifacts", async () => {
		for (const providerId of ["google", "opencode-go"]) {
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
				inputs.some((inputPath) =>
					inputPath.endsWith("generated/model-metadata.generated.ts")
				)
			).toBe(false);
		}

		const googleInputs = await bundledInputsFor(
			path.join(AI_ROOT, "src/sdk-providers/google.ts")
		);
		expect(
			googleInputs.some((inputPath) =>
				inputPath.endsWith("generated/google-model-metadata.generated.ts")
			)
		).toBe(true);
		expect(
			googleInputs.some((inputPath) =>
				inputPath.endsWith("generated/google-sdk-models.generated.ts")
			)
		).toBe(true);

		const openCodeGoInputs = await bundledInputsFor(
			path.join(AI_ROOT, "src/sdk-providers/opencode-go.ts")
		);
		expect(
			openCodeGoInputs.some((inputPath) =>
				inputPath.endsWith("generated/anthropic-model-metadata.generated.ts")
			)
		).toBe(false);
		expect(
			openCodeGoInputs.some((inputPath) =>
				ANTHROPIC_MODEL_ARTIFACT.test(inputPath)
			)
		).toBe(false);
		expect(
			openCodeGoInputs.some((inputPath) =>
				inputPath.endsWith("generated/opencode-go-sdk-models.generated.ts")
			)
		).toBe(true);
		expect(
			openCodeGoInputs.some((inputPath) =>
				inputPath.endsWith("generated/opencode-go-model-metadata.generated.ts")
			)
		).toBe(true);
	});
});

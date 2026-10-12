import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");
const PROVIDER_ENTRYPOINT = path.join(
	REPOSITORY_ROOT,
	"packages/ai/src/sdk-providers/anthropic.ts"
);

describe("Anthropic SDK provider import graph", () => {
	test("Anthropic factory bundles without other built-ins or the all-provider catalog", async () => {
		const outputDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "wincode-anthropic-sdk-graph-")
		);
		const metafilePath = path.join(outputDir, "metafile.json");
		try {
			const build = Bun.spawn(
				[
					"bun",
					"build",
					PROVIDER_ENTRYPOINT,
					"--bundle",
					`--metafile=${metafilePath}`,
					`--outdir=${outputDir}`,
					"--target=bun",
				],
				{
					cwd: REPOSITORY_ROOT,
					stderr: "pipe",
					stdout: "pipe",
				}
			);
			const [exitCode, stderr, stdout] = await Promise.all([
				build.exited,
				new Response(build.stderr).text(),
				new Response(build.stdout).text(),
			]);
			if (exitCode !== 0) {
				throw new Error(`Anthropic bundle failed.\n${stdout}${stderr}`);
			}
			const metafile = (await Bun.file(metafilePath).json()) as {
				inputs: Record<string, unknown>;
			};
			const inputs = Object.keys(metafile.inputs);
			expect(
				inputs.some((input) =>
					input.endsWith("generated/model-metadata.generated.ts")
				)
			).toBe(false);
			expect(
				inputs
					.filter((input) => input.includes("/sdk-providers/"))
					.map((input) => path.basename(input))
			).toEqual(["anthropic.ts"]);
			expect(
				inputs.some((input) =>
					input.endsWith("generated/anthropic-model-metadata.generated.ts")
				)
			).toBe(true);
		} finally {
			await fs.rm(outputDir, { force: true, recursive: true });
		}
	});
});

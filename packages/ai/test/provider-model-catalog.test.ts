import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");
const GENERATOR_PATH = path.join(
	REPOSITORY_ROOT,
	"packages/ai/scripts/sync-provider-model-catalog.ts"
);
const CURATED_CAPABILITIES_PATTERN =
	/"capabilities": \[\s*"text",\s*"tools"\s*\]/u;

type CommandResult = Readonly<{
	exitCode: number;
	stderr: string;
	stdout: string;
}>;

type TemporaryCatalog = Readonly<{
	outputDirectory: string;
	run: (args?: readonly string[]) => Promise<CommandResult>;
}>;

const runGenerator = async (
	args: readonly string[] = []
): Promise<CommandResult> => {
	const child = Bun.spawn([process.execPath, "run", GENERATOR_PATH, ...args], {
		cwd: REPOSITORY_ROOT,
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stderr, stdout] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text(),
	]);
	return { exitCode, stderr, stdout };
};

const withTemporaryCatalog = async (
	prefix: string,
	manifest: unknown,
	modelsDevPayload: unknown,
	runTest: (catalog: TemporaryCatalog) => Promise<void>
): Promise<void> => {
	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const manifestPath = path.join(temporaryDirectory, "manifest.json");
	const modelsDevPath = path.join(temporaryDirectory, "models-dev.json");
	const outputDirectory = path.join(temporaryDirectory, "generated");
	const generatorArgs = [
		"--manifest",
		manifestPath,
		"--models-dev-data",
		modelsDevPath,
		"--output-dir",
		outputDirectory,
	];
	try {
		await Bun.write(manifestPath, JSON.stringify(manifest));
		await Bun.write(modelsDevPath, JSON.stringify(modelsDevPayload));
		await runTest({
			outputDirectory,
			run: (args = []) => runGenerator([...generatorArgs, ...args]),
		});
	} finally {
		await fs.rm(temporaryDirectory, { force: true, recursive: true });
	}
};

const manifestFixture = {
	providers: [
		{
			models: [
				"gpt-6-terra",
				{
					capabilities: ["text", "tools"],
					modelId: "gpt-6-chat-example",
					protocolId: "openai-chat",
				},
			],
			protocolId: "openai-responses",
			providerId: "openai",
		},
		{
			models: ["gpt-6-terra"],
			protocolId: "anthropic",
			providerId: "anthropic",
		},
	],
};

const modelsDevFixture = {
	openai: {
		models: {
			"gpt-6-terra": {
				cost: { input: 1, output: 2 },
				limit: { context: 1000, output: 200 },
			},
			"not-declared": {
				cost: { input: 99, output: 99 },
				limit: { context: 99_000 },
			},
		},
	},
};

describe("combined provider model catalog generator", () => {
	test("generated catalog retains source provenance and enriches only declared identities", async () => {
		await withTemporaryCatalog(
			"wincode-provider-model-catalog-",
			manifestFixture,
			modelsDevFixture,
			async ({ outputDirectory, run }) => {
				const generated = await run();
				expect(generated.exitCode).toBe(0);

				const openAIOutput = path.join(outputDirectory, "openai.generated.ts");
				const openAIContents = await Bun.file(openAIOutput).text();
				const provenance = openAIContents
					.split(String.fromCharCode(10))
					.find((line) => line.startsWith("// Snapshot date:"));
				expect(provenance).toBeDefined();
				expect(provenance).toContain(". Source: https://models.dev/api.json.");
				expect(openAIContents).toContain('"modelId": "gpt-6-terra"');
				expect(openAIContents).toContain('"protocolId": "openai-responses"');
				expect(openAIContents).toContain('"protocolId": "openai-chat"');
				expect(openAIContents).toContain('"providerId": "openai"');
				expect(openAIContents).toContain('"inputPerMillionTokensUsd": 1');
				expect(openAIContents).toContain('"outputPerMillionTokensUsd": 2');
				expect(openAIContents).toContain('"contextWindowTokens": 1000');
				expect(openAIContents).toContain('"maxOutputTokens": 200');
				expect(openAIContents).toContain('"promptCache": {');
				expect(openAIContents).toMatch(CURATED_CAPABILITIES_PATTERN);
				expect(openAIContents).not.toContain('"modelId": "not-declared"');

				const current = await run(["--check"]);
				expect(current.exitCode).toBe(0);
				await Bun.write(openAIOutput, `${openAIContents}// stale\n`);

				const changed = await run(["--check"]);
				expect(changed.exitCode).not.toBe(0);
				expect(changed.stderr).toContain("stale");

				const restoredAfterChange = await run();
				expect(restoredAfterChange.exitCode).toBe(0);
				await fs.rm(openAIOutput);
				const missing = await run(["--check"]);
				expect(missing.exitCode).not.toBe(0);
				expect(missing.stderr).toContain("changed or missing: openai");

				const restoredAfterMissing = await run();
				expect(restoredAfterMissing.exitCode).toBe(0);
				const obsoleteOutput = path.join(
					outputDirectory,
					"obsolete.generated.ts"
				);
				await Bun.write(obsoleteOutput, "obsolete");
				const obsolete = await run(["--check"]);
				expect(obsolete.exitCode).not.toBe(0);
				expect(obsolete.stderr).toContain("obsolete.generated.ts");

				const regenerated = await run();
				expect(regenerated.exitCode).toBe(0);
				expect(await Bun.file(openAIOutput).exists()).toBe(true);
				expect(await Bun.file(obsoleteOutput).exists()).toBe(false);
			}
		);
	});

	test("duplicate provider IDs fail rather than merging separate inventories", async () => {
		await withTemporaryCatalog(
			"wincode-provider-model-catalog-provider-",
			{
				providers: [
					{
						models: ["first-model"],
						protocolId: "openai-responses",
						providerId: "openai",
					},
					{
						models: ["second-model"],
						protocolId: "openai-chat",
						providerId: "openai",
					},
				],
			},
			{},
			async ({ outputDirectory, run }) => {
				const result = await run();
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain("Duplicate provider ID 'openai'.");
				expect(
					await Bun.file(
						path.join(outputDirectory, "openai.generated.ts")
					).exists()
				).toBe(false);
			}
		);
	});

	test("duplicate model identities fail rather than silently replacing a model", async () => {
		await withTemporaryCatalog(
			"wincode-provider-model-catalog-duplicate-",
			{
				providers: [
					{
						models: ["same-model", "same-model"],
						protocolId: "openai-responses",
						providerId: "openai",
					},
				],
			},
			{},
			async ({ run }) => {
				const result = await run();
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain(
					"Duplicate Provider Model 'openai/same-model'."
				);
			}
		);
	});
});

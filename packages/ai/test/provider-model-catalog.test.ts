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

const GENERATED_MODELS_PATTERN =
	/export const providerModels = ([\s\S]*?) as const satisfies readonly ProviderModel\[\];/u;

type GeneratedModel = Readonly<{
	limits?: Readonly<{ contextWindowTokens?: number }>;
	promptCache?: unknown;
	modelFamily?: string;
	modelId: string;
}>;

const generatedModelsFrom = async (
	outputDirectory: string,
	providerId: string
): Promise<readonly GeneratedModel[]> => {
	const contents = await Bun.file(
		path.join(outputDirectory, `${providerId}.generated.ts`)
	).text();
	const serializedModels = contents.match(GENERATED_MODELS_PATTERN)?.[1];
	if (serializedModels === undefined) {
		throw new Error(`Could not read generated models for '${providerId}'.`);
	}
	return JSON.parse(serializedModels) as readonly GeneratedModel[];
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

	test("routed context policy follows explicit model family, not model name", async () => {
		await withTemporaryCatalog(
			"wincode-provider-model-family-policy-",
			{
				providers: [
					{
						models: [
							{ modelFamily: "openai", modelId: "gpt-routed" },
							{ modelFamily: "deepseek", modelId: "deepseek-routed" },
							"gpt-unclassified",
							{ modelFamily: "openai", modelId: "custom-openai-family" },
						],
						protocolId: "openai-compatible",
						providerId: "opencode-go",
					},
					{
						models: [{ modelFamily: "openai", modelId: "gpt-routed" }],
						protocolId: "openai-compatible",
						providerId: "openrouter",
					},
				],
			},
			{
				"opencode-go": {
					models: {
						"gpt-routed": { limit: { context: 1_050_000 } },
						"deepseek-routed": { limit: { context: 1_000_000 } },
						"gpt-unclassified": { limit: { context: 1_000_000 } },
						"custom-openai-family": { limit: { context: 1_000_000 } },
					},
				},
				openrouter: {
					models: {
						"gpt-routed": { limit: { context: 1_000_000 } },
					},
				},
			},
			async ({ outputDirectory, run }) => {
				const generated = await run();
				expect(generated.exitCode).toBe(0);

				const openCodeGoModels = await generatedModelsFrom(
					outputDirectory,
					"opencode-go"
				);
				const contextFor = (
					models: readonly GeneratedModel[],
					modelId: string
				) =>
					models.find((model) => model.modelId === modelId)?.limits
						?.contextWindowTokens;
				expect(contextFor(openCodeGoModels, "gpt-routed")).toBe(272_000);
				expect(contextFor(openCodeGoModels, "deepseek-routed")).toBe(272_000);
				expect(contextFor(openCodeGoModels, "gpt-unclassified")).toBe(
					1_000_000
				);
				expect(contextFor(openCodeGoModels, "custom-openai-family")).toBe(
					272_000
				);
				expect(
					openCodeGoModels.every((model) => model.modelFamily === undefined)
				).toBe(true);

				const openRouterModels = await generatedModelsFrom(
					outputDirectory,
					"openrouter"
				);
				expect(contextFor(openRouterModels, "gpt-routed")).toBe(1_000_000);
			}
		);
	});

	test("family metadata stays scoped to its provider route", async () => {
		await withTemporaryCatalog(
			"wincode-provider-family-route-",
			{
				providers: [
					{
						modelFamily: "openai",
						models: ["gpt-5.6-luna"],
						protocolId: "openai-responses",
						providerId: "openai",
					},
					{
						models: [{ modelFamily: "openai", modelId: "gpt-5.6-luna" }],
						protocolId: "openai-compatible",
						providerId: "opencode-go",
					},
					{
						models: [{ modelFamily: "openai", modelId: "gpt-5.6-luna" }],
						protocolId: "openai-compatible",
						providerId: "openrouter",
					},
				],
			},
			{
				openai: {
					models: {
						"gpt-5.6-luna": { limit: { context: 1_050_000 } },
					},
				},
				"opencode-go": {
					models: {
						"gpt-5.6-luna": { limit: { context: 1_050_000 } },
					},
				},
				openrouter: {
					models: {
						"gpt-5.6-luna": { limit: { context: 1_000_000 } },
					},
				},
			},
			async ({ outputDirectory, run }) => {
				const generated = await run();
				expect(generated.exitCode).toBe(0);
				const direct = await generatedModelsFrom(outputDirectory, "openai");
				const routed = await generatedModelsFrom(
					outputDirectory,
					"opencode-go"
				);
				const proxied = await generatedModelsFrom(
					outputDirectory,
					"openrouter"
				);
				const directModel = direct.find(
					(model) => model.modelId === "gpt-5.6-luna"
				);
				const routedModel = routed.find(
					(model) => model.modelId === "gpt-5.6-luna"
				);
				const proxiedModel = proxied.find(
					(model) => model.modelId === "gpt-5.6-luna"
				);

				expect(directModel?.limits?.contextWindowTokens).toBe(272_000);
				expect(directModel).toHaveProperty("promptCache");
				expect(routedModel?.limits?.contextWindowTokens).toBe(272_000);
				expect(routedModel).not.toHaveProperty("promptCache");
				expect(proxiedModel?.limits?.contextWindowTokens).toBe(1_000_000);
				expect(proxiedModel).not.toHaveProperty("promptCache");
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

// Usage:
//   bun run sync-provider-model-catalog [--check]
//   bun run sync-provider-model-catalog -- --manifest <path> --models-dev-data <path> --output-dir <path>

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readUtf8File } from "@wincode/utils";
import { MANUAL_OVERLAYS } from "./manual-model-overlays.ts";
import { buildProviderModelsWithMetadata } from "./metadata-model.ts";
import {
	generateProviderModelCatalog,
	PROVIDER_MODEL_CATALOG_SOURCE_PATH,
	parseProviderModelCatalogSource,
} from "./provider-model-catalog.ts";

const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
const REQUEST_TIMEOUT_MS = 20_000;
const SNAPSHOT_DATE_PATTERN = /^\/\/ Snapshot date: (\d{4}-\d{2}-\d{2})\./m;
const DEFAULT_OUTPUT_DIR = path.join(import.meta.dir, "../src/generated");

type SyncOptions = Readonly<{
	check: boolean;
	manifestPath: string;
	modelsDevDataPath?: string;
	outputDir: string;
}>;

const parseOptions = (args: readonly string[]): SyncOptions => {
	let check = false;
	let manifestPath = PROVIDER_MODEL_CATALOG_SOURCE_PATH;
	let modelsDevDataPath: string | undefined;
	let outputDir = DEFAULT_OUTPUT_DIR;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--check") {
			check = true;
			continue;
		}
		if (
			argument !== "--manifest" &&
			argument !== "--models-dev-data" &&
			argument !== "--output-dir"
		) {
			throw new Error(`Unknown provider catalog option '${argument}'.`);
		}
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`Expected a path after '${argument}'.`);
		}
		if (argument === "--manifest") {
			manifestPath = path.resolve(value);
		} else if (argument === "--models-dev-data") {
			modelsDevDataPath = path.resolve(value);
		} else {
			outputDir = path.resolve(value);
		}
		index += 1;
	}
	return { check, manifestPath, modelsDevDataPath, outputDir };
};

const sourceUrlForOutput = (value: string): string => {
	try {
		const parsed = new URL(value);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return "[invalid models.dev URL]";
	}
};

const snapshotDateFromOutput = async (
	outputDir: string
): Promise<string | undefined> => {
	let fileNames: string[];
	try {
		fileNames = await fs.readdir(outputDir);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
	for (const fileName of fileNames) {
		if (!fileName.endsWith(".generated.ts")) {
			continue;
		}
		const contents = await readUtf8File(path.join(outputDir, fileName));
		const snapshotDate = contents.match(SNAPSHOT_DATE_PATTERN)?.[1];
		if (snapshotDate !== undefined) {
			return snapshotDate;
		}
	}
	return;
};

const modelsDevPayloadFor = async (
	modelsDevDataPath: string | undefined
): Promise<Readonly<{ payload: unknown; source: string }>> => {
	if (modelsDevDataPath !== undefined) {
		return {
			payload: await Bun.file(modelsDevDataPath).json(),
			source: modelsDevDataPath,
		};
	}
	const url = process.env.WINCODE_MODELS_URL ?? DEFAULT_MODELS_DEV_URL;
	const source = sourceUrlForOutput(url);
	const response = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`models.dev returned ${response.status} for ${source}`);
	}
	return { payload: await response.json(), source };
};

const { check, manifestPath, modelsDevDataPath, outputDir } = parseOptions(
	process.argv.slice(2)
);
const catalogSourceInput: unknown = await Bun.file(manifestPath).json();
const catalogSource = parseProviderModelCatalogSource(catalogSourceInput);
const modelsDev = await modelsDevPayloadFor(modelsDevDataPath);
const declaredModels = catalogSource.providers.flatMap(({ models }) => models);
const enriched = buildProviderModelsWithMetadata({
	modelFamilies: catalogSource.modelFamilies,
	overlays: MANUAL_OVERLAYS,
	payload: modelsDev.payload,
	providerModels: declaredModels,
});
const snapshotDate = check
	? ((await snapshotDateFromOutput(outputDir)) ??
		new Date().toISOString().slice(0, 10))
	: new Date().toISOString().slice(0, 10);
const source =
	modelsDevDataPath === undefined
		? modelsDev.source
		: sourceUrlForOutput(
				process.env.WINCODE_MODELS_URL ?? DEFAULT_MODELS_DEV_URL
			);
const generatedFiles = generateProviderModelCatalog(enriched.providerModels, {
	snapshotDate,
	source,
});
const expectedFileNames = new Set(
	generatedFiles.map(({ fileName }) => fileName)
);

process.stdout.write(
	`${enriched.coverage.providerModelCount} Provider SDK models\n` +
		`  from ${modelsDev.source}: ${enriched.coverage.fromSource}\n` +
		`  from manual overlay: ${enriched.coverage.fromOverlay.join(", ") || "none"}\n` +
		`  absent upstream: ${enriched.coverage.absentUpstream.join(", ") || "none"}\n`
);

const existingFileNames = async (): Promise<readonly string[]> => {
	try {
		return await fs.readdir(outputDir);
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}
};

const staleFileNames = (await existingFileNames()).filter(
	(fileName) =>
		fileName.endsWith(".generated.ts") && !expectedFileNames.has(fileName)
);

if (check) {
	const changedProviderIds: string[] = [];
	for (const file of generatedFiles) {
		const outputPath = path.join(outputDir, file.fileName);
		const current = Bun.file(outputPath);
		if (
			!(await current.exists()) ||
			(await readUtf8File(outputPath)) !== file.contents
		) {
			changedProviderIds.push(file.providerId);
		}
	}
	if (changedProviderIds.length > 0 || staleFileNames.length > 0) {
		throw new Error(
			`Generated Provider Model catalog is stale (changed or missing: ${changedProviderIds.join(", ") || "none"}; obsolete: ${staleFileNames.join(", ") || "none"}). Run \`bun run sync-provider-model-catalog\`.`
		);
	}
	process.stdout.write(
		`Provider Model catalog is current (${generatedFiles.length} providers).\n`
	);
} else {
	await Promise.all(
		generatedFiles.map((file) =>
			Bun.write(path.join(outputDir, file.fileName), file.contents)
		)
	);
	await Promise.all(
		staleFileNames.map((fileName) =>
			fs.rm(path.join(outputDir, fileName), { force: true })
		)
	);
	process.stdout.write(
		`Wrote Provider Model catalog for ${generatedFiles.length} providers to ${outputDir}.\n`
	);
}

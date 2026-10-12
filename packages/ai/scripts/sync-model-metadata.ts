// Regenerates shared and provider-only model metadata.
//
// Usage: bun run packages/ai/scripts/sync-model-metadata.ts [--check]
//
// Sources, in order of authority:
//   1. manual overlays declared below (facts models.dev does not publish);
//   2. `https://models.dev/api.json` (reasoning options, cost, limits).
//
// Entries absent upstream are reported, never fabricated. Run with `--check`
// to fail when the committed file is not what the current inputs produce.

import * as path from "node:path";
import { readUtf8File } from "@wincode/utils";
import { modelCatalog } from "../src/catalog";
import { buildModelMetadataFile, MANUAL_OVERLAYS } from "./metadata-model";

const DEFAULT_URL = "https://models.dev/api.json";
const REQUEST_TIMEOUT_MS = 20_000;
const OUTPUT_PATH = path.join(
	import.meta.dir,
	"../src/generated/model-metadata.generated.ts"
);
const ANTHROPIC_MODEL_METADATA_OUTPUT_PATH = path.join(
	import.meta.dir,
	"../src/generated/anthropic-model-metadata.generated.ts"
);
const OPENAI_PROMPT_CACHE_OUTPUT_PATH = path.join(
	import.meta.dir,
	"../src/generated/openai-prompt-cache.generated.ts"
);
const GOOGLE_MODEL_METADATA_OUTPUT_PATH = path.join(
	import.meta.dir,
	"../src/generated/google-model-metadata.generated.ts"
);
const GOOGLE_SDK_MODELS_OUTPUT_PATH = path.join(
	import.meta.dir,
	"../src/generated/google-sdk-models.generated.ts"
);
const OPENCODE_GO_MODEL_METADATA_OUTPUT_PATH = path.join(
	import.meta.dir,
	"../src/generated/opencode-go-model-metadata.generated.ts"
);
const OPENCODE_GO_SDK_MODELS_OUTPUT_PATH = path.join(
	import.meta.dir,
	"../src/generated/opencode-go-sdk-models.generated.ts"
);

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

const isCheck = process.argv.includes("--check");
const current = isCheck ? await readUtf8File(OUTPUT_PATH) : undefined;
const currentAnthropicModelMetadata = isCheck
	? await readUtf8File(ANTHROPIC_MODEL_METADATA_OUTPUT_PATH)
	: undefined;
const currentOpenAIPromptCache = isCheck
	? await readUtf8File(OPENAI_PROMPT_CACHE_OUTPUT_PATH)
	: undefined;
const currentGoogleModelMetadata = isCheck
	? await readUtf8File(GOOGLE_MODEL_METADATA_OUTPUT_PATH)
	: undefined;
const currentGoogleSdkModels = isCheck
	? await readUtf8File(GOOGLE_SDK_MODELS_OUTPUT_PATH)
	: undefined;
const currentOpenCodeGoModelMetadata = isCheck
	? await readUtf8File(OPENCODE_GO_MODEL_METADATA_OUTPUT_PATH)
	: undefined;
const currentOpenCodeGoSdkModels = isCheck
	? await readUtf8File(OPENCODE_GO_SDK_MODELS_OUTPUT_PATH)
	: undefined;
const committedSnapshotDate = current?.match(
	/^\/\/ Snapshot date: (\d{4}-\d{2}-\d{2})\./m
)?.[1];

const url = process.env.WINCODE_MODELS_URL ?? DEFAULT_URL;
const sourceUrl = sourceUrlForOutput(url);

const response = await fetch(url, {
	headers: { accept: "application/json" },
	signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

if (!response.ok) {
	throw new Error(`models.dev returned ${response.status} for ${sourceUrl}`);
}

const payload: unknown = await response.json();
const generatedAt =
	committedSnapshotDate ?? new Date().toISOString().slice(0, 10);

const rendered = buildModelMetadataFile({
	catalog: modelCatalog,
	generatedAt,
	overlays: MANUAL_OVERLAYS,
	payload,
	source: sourceUrl,
});

process.stdout.write(
	`${rendered.coverage.activeEntries} active catalog entries\n` +
		`  from ${sourceUrl}: ${rendered.coverage.fromSource}\n` +
		`  from manual overlay: ${rendered.coverage.fromOverlay.join(", ") || "none"}\n` +
		`  absent upstream: ${rendered.coverage.absentUpstream.join(", ") || "none"}\n`
);

if (isCheck) {
	if (
		current !== rendered.contents ||
		currentAnthropicModelMetadata !== rendered.anthropicModelMetadataContents ||
		currentOpenAIPromptCache !== rendered.openAIPromptCacheContents ||
		currentGoogleModelMetadata !== rendered.googleModelMetadataContents ||
		currentGoogleSdkModels !== rendered.googleSdkModelsContents ||
		currentOpenCodeGoModelMetadata !==
			rendered.openCodeGoModelMetadataContents ||
		currentOpenCodeGoSdkModels !== rendered.openCodeGoSdkModelsContents
	) {
		throw new Error(
			"Generated model metadata is stale. Run `bun run packages/ai/scripts/sync-model-metadata.ts`."
		);
	}
	process.stdout.write("Generated model metadata is current.\n");
} else {
	await Promise.all([
		Bun.write(OUTPUT_PATH, rendered.contents),
		Bun.write(
			ANTHROPIC_MODEL_METADATA_OUTPUT_PATH,
			rendered.anthropicModelMetadataContents
		),
		Bun.write(
			OPENAI_PROMPT_CACHE_OUTPUT_PATH,
			rendered.openAIPromptCacheContents
		),
		Bun.write(
			GOOGLE_MODEL_METADATA_OUTPUT_PATH,
			rendered.googleModelMetadataContents
		),
		Bun.write(GOOGLE_SDK_MODELS_OUTPUT_PATH, rendered.googleSdkModelsContents),
		Bun.write(
			OPENCODE_GO_MODEL_METADATA_OUTPUT_PATH,
			rendered.openCodeGoModelMetadataContents
		),
		Bun.write(
			OPENCODE_GO_SDK_MODELS_OUTPUT_PATH,
			rendered.openCodeGoSdkModelsContents
		),
	]);
	process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
	process.stdout.write(`Wrote ${ANTHROPIC_MODEL_METADATA_OUTPUT_PATH}\n`);
	process.stdout.write(`Wrote ${OPENAI_PROMPT_CACHE_OUTPUT_PATH}\n`);
	process.stdout.write(`Wrote ${GOOGLE_MODEL_METADATA_OUTPUT_PATH}\n`);
	process.stdout.write(`Wrote ${GOOGLE_SDK_MODELS_OUTPUT_PATH}\n`);
	process.stdout.write(`Wrote ${OPENCODE_GO_MODEL_METADATA_OUTPUT_PATH}\n`);
	process.stdout.write(`Wrote ${OPENCODE_GO_SDK_MODELS_OUTPUT_PATH}\n`);
}

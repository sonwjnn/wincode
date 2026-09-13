// Regenerates `packages/ai/src/generated/model-metadata.generated.ts`.
//
// Usage: bun run packages/ai/scripts/sync-model-metadata.ts [--check]
//
// Sources, in order of authority:
//   1. manual overlays declared below (facts models.dev does not publish);
//   2. `https://models.dev/api.json` (reasoning options, cost, limits).
//
// Entries absent upstream are reported, never fabricated. Run with `--check`
// to fail when the committed file is not what the current inputs produce.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { modelCatalog } from "../src/catalog";
import { buildModelMetadataFile, MANUAL_OVERLAYS } from "./metadata-model";

const DEFAULT_URL = "https://models.dev/api.json";
const REQUEST_TIMEOUT_MS = 20_000;
const OUTPUT_PATH = join(
	import.meta.dir,
	"../src/generated/model-metadata.generated.ts"
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
const current = isCheck ? await readFile(OUTPUT_PATH, "utf8") : undefined;
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
	if (current !== rendered.contents) {
		throw new Error(
			"Generated model metadata is stale. Run `bun run packages/ai/scripts/sync-model-metadata.ts`."
		);
	}
	process.stdout.write("Generated model metadata is current.\n");
} else {
	await writeFile(OUTPUT_PATH, rendered.contents);
	process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
}

/**
 * Writes the committed tier manifest consumed by `scripts/test-portfolio.ts`.
 *
 *   bun scripts/test-curation/tiers.ts
 *
 * Requires `history.json` and the run1 timings from a full harness run (see
 * `scripts/test-curation/README.md`). The assignment itself lives in
 * `tiering.ts`, so the audit log table and this manifest cannot disagree.
 */
import * as path from "node:path";
import { $ } from "bun";
import { TEST_TIERS, TEST_TIERS_PATH, type TestTier } from "../test-discovery";
import { defaultTestFiles, readJson, repoRoot, writeJson } from "./lib";
import { assignTestTiers } from "./tiering";

type History = Readonly<{
	addedTestsByFile: Readonly<Record<string, readonly unknown[]>>;
	testFileFixCounts: readonly Readonly<{ file: string; fixes: number }>[];
}>;

const root = repoRoot();
const artifacts = path.join(root, ".tmp/test-curation");
const history = await readJson<History>(
	path.join(artifacts, "analysis/history.json")
);

const files = defaultTestFiles().map((entry) => entry.path);
const durationsMs = new Map<string, number>();
const timingsDirectory = path.join(artifacts, "timings");
for (const name of await Array.fromAsync(
	new Bun.Glob("run1-*.json").scan({ cwd: timingsDirectory })
)) {
	const parsed = await readJson<{ files?: Record<string, number> }>(
		path.join(timingsDirectory, name)
	);
	for (const [file, value] of Object.entries(parsed.files ?? {})) {
		durationsMs.set(file, value);
	}
}

const assigned = assignTestTiers({
	addedTestsByFile: history.addedTestsByFile,
	durationsMs,
	files,
	testFileFixCounts: history.testFileFixCounts,
});

const tiers: Record<string, TestTier> = {};
const counts: Record<TestTier, number> = { core: 0, extended: 0, smoke: 0 };
for (const file of [...assigned.keys()].sort()) {
	const tier = assigned.get(file);
	if (tier === undefined) {
		throw new Error(`No tier assigned to ${file}`);
	}
	tiers[file] = tier;
	counts[tier] += 1;
}

const source = (
	await $`git rev-parse --short HEAD`.cwd(root).quiet().text()
).trim();
await writeJson(path.join(root, TEST_TIERS_PATH), {
	source,
	tiers,
	version: 1,
});

for (const tier of TEST_TIERS) {
	console.log(`${tier}: ${counts[tier]} files`);
}
console.log(`wrote ${TEST_TIERS_PATH} (${files.length} files from ${source})`);

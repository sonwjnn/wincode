/**
 * Same-SHA flake detection.
 *
 *   bun scripts/test-curation/flake.ts [label...]
 *
 * Flakiness is the same commit producing both a pass and a fail, so this
 * compares complete JUnit runs of one commit. Two or more labels are required;
 * `baseline.ts` writes one run per label. Writes `flakes.json`.
 */
import * as path from "node:path";
import {
	analysisDir,
	artifactsRoot,
	ensureArtifacts,
	loadJunitRun,
	writeJson,
} from "./lib";

const labels = process.argv.slice(2);
if (labels.length < 2) {
	throw new Error("usage: flake.ts <label-a> <label-b> [label...]");
}
await ensureArtifacts();
const artifacts = artifactsRoot();
const runs = await Promise.all(
	labels.map((label) => loadJunitRun(artifacts, label))
);
const key = (entry: { file: string; name: string; suite: string }): string =>
	`${entry.file}|${entry.suite}|${entry.name}`;

const outcomes = new Map<string, Record<string, string>>();
const testsPerRun: Record<string, number> = {};
runs.forEach((run, index) => {
	const label = labels[index] ?? `run${index}`;
	testsPerRun[label] = run.length;
	for (const testCase of run) {
		const record = outcomes.get(key(testCase)) ?? {};
		record[label] = testCase.status;
		outcomes.set(key(testCase), record);
	}
});

const flaky: { outcomes: Record<string, string>; test: string }[] = [];
const missing: { present: string[]; test: string }[] = [];
for (const [test, record] of outcomes) {
	const present = labels.filter((label) => record[label] !== undefined);
	if (present.length < labels.length) {
		missing.push({ present, test });
		continue;
	}
	if (new Set(present.map((label) => record[label])).size > 1) {
		flaky.push({ outcomes: record, test });
	}
}

const durations = new Map<string, number[]>();
runs.forEach((run, index) => {
	for (const testCase of run) {
		const bucket = durations.get(key(testCase)) ?? [];
		bucket[index] = testCase.timeMs;
		durations.set(key(testCase), bucket);
	}
});
const slowestVariance = [...durations.entries()]
	.map(([test, values]) => ({
		spread: Math.max(...values) - Math.min(...values),
		test,
		values,
	}))
	.filter((entry) => entry.spread > 500)
	.sort((left, right) => right.spread - left.spread)
	.slice(0, 15);

await writeJson(path.join(analysisDir(), "flakes.json"), {
	flakySameSha: flaky,
	labels,
	missingCount: missing.length,
	missingFromSomeRun: missing.slice(0, 50),
	testsPerRun,
	timingSpreadOver500ms: slowestVariance,
});
console.log(
	JSON.stringify(
		{
			flakySameSha: flaky.length,
			flakyExamples: flaky.slice(0, 10),
			missingCount: missing.length,
			testsPerRun,
			timingSpreadOver500ms: slowestVariance.length,
		},
		null,
		2
	)
);

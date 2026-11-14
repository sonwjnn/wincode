/**
 * Runs the Default Test Portfolio once and records per-test outcomes.
 *
 *   bun scripts/test-curation/baseline.ts [label]
 *
 * Writes `<artifacts>/junit/<label>/<package>.xml` and
 * `<artifacts>/analysis/baseline-<label>.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	artifactsRoot,
	defaultTestFiles,
	ensureArtifacts,
	repoRoot,
	runBunTest,
	testEnvironment,
	writeJson,
} from "./lib";

const TEST_TIMEOUT_MS = 30_000;
const label = process.argv[2] ?? "run1";
const root = repoRoot();
const artifacts = artifactsRoot();
await ensureArtifacts();

const grouped = new Map<string, string[]>();
for (const file of defaultTestFiles()) {
	const bucket = grouped.get(file.packageName) ?? [];
	bucket.push(file.path);
	grouped.set(file.packageName, bucket);
}

const summary: Record<string, unknown>[] = [];
for (const [packageName, files] of grouped) {
	const junitPath = path.join(artifacts, "junit", label, `${packageName}.xml`);
	const timingsPath = path.join(
		artifacts,
		"timings",
		`${label}-${packageName}.json`
	);
	await fs.mkdir(path.dirname(junitPath), { recursive: true });
	await fs.mkdir(path.dirname(timingsPath), { recursive: true });
	await Bun.write(timingsPath, JSON.stringify({ files: {}, version: 1 }));
	const result = await runBunTest(
		[
			"test",
			"--timeout",
			String(TEST_TIMEOUT_MS),
			"--no-orphans",
			"--reporter=junit",
			`--reporter-outfile=${junitPath}`,
			`--timings=${timingsPath}`,
			"--update-timings",
			...files,
		],
		{
			cwd: root,
			env: testEnvironment(),
			logPath: path.join(artifacts, "logs", label, `${packageName}.log`),
		}
	);
	summary.push({
		exitCode: result.exitCode,
		files: files.length,
		packageName,
		wallMs: result.wallMs,
	});
	console.log(
		`baseline ${packageName}: exit=${result.exitCode} files=${files.length} ${Math.round(result.wallMs / 1000)}s`
	);
}

await writeJson(
	path.join(artifacts, "analysis", `baseline-${label}.json`),
	summary
);

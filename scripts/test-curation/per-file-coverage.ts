/**
 * Shards the Default Test Portfolio into one coverage run per test file.
 *
 *   bun scripts/test-curation/per-file-coverage.ts [concurrency]
 *
 * Writes `<artifacts>/cov/<slug>/lcov.info` and
 * `<artifacts>/analysis/coverage-runs.json`.
 */
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
const concurrency = Number(process.argv[2] ?? 6);
const root = repoRoot();
const artifacts = artifactsRoot();
await ensureArtifacts();

const files = defaultTestFiles();
const queue = [...files];
const results: {
	exitCode: number;
	lcovBytes: number;
	path: string;
	wallMs: number;
}[] = [];
let completed = 0;

const worker = async (): Promise<void> => {
	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined) {
			return;
		}
		const directory = path.join(
			artifacts,
			"cov",
			file.path.replace(/[\\/]/g, "__")
		);
		const result = await runBunTest(
			[
				"test",
				"--timeout",
				String(TEST_TIMEOUT_MS),
				"--no-orphans",
				"--coverage",
				"--coverage-reporter=lcov",
				`--coverage-dir=${directory}`,
				file.path,
			],
			{
				cwd: root,
				env: testEnvironment(),
				logPath: path.join(
					artifacts,
					"logs",
					"coverage",
					`${file.path.replace(/[\\/]/g, "__")}.log`
				),
			}
		);
		const lcov = Bun.file(path.join(directory, "lcov.info"));
		results.push({
			exitCode: result.exitCode,
			lcovBytes: (await lcov.exists()) ? lcov.size : 0,
			path: file.path,
			wallMs: result.wallMs,
		});
		completed += 1;
		if (completed % 20 === 0) {
			console.log(`coverage ${completed}/${files.length}`);
		}
	}
};

await Promise.all(Array.from({ length: concurrency }, worker));
results.sort((left, right) => (left.path < right.path ? -1 : 1));
await writeJson(
	path.join(artifacts, "analysis", "coverage-runs.json"),
	results
);
const failed = results.filter((entry) => entry.exitCode !== 0);
console.log(
	`coverage done: ${results.length} files, ${failed.length} non-zero exits`
);
for (const entry of failed) {
	console.log(`  exit ${entry.exitCode}: ${entry.path}`);
}

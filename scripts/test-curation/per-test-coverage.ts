/**
 * Measures the application lines each individual test case covers.
 *
 *   bun scripts/test-curation/per-test-coverage.ts [concurrency]
 *
 * Bun exposes no coverage.py-style dynamic contexts, so each test runs alone
 * (`-t <escaped name>`) and its lcov report is folded into a compact line-id
 * array immediately. The unit of fingerprinting is therefore one test case,
 * which is finer than `per-file-coverage.ts` but discards cross-test state.
 *
 * Writes `<artifacts>/analysis/per-test-fingerprints.jsonl` and
 * `per-test-line-index.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	analysisDir,
	applicationLineKey,
	artifactsRoot,
	ensureArtifacts,
	parseJunit,
	parseLcov,
	repoRoot,
	runBunTest,
	slug,
	testEnvironment,
	writeJson,
} from "./lib";

const TEST_TIMEOUT_MS = 30_000;
const concurrency = Number(process.argv[2] ?? 8);
const root = repoRoot();
const artifacts = artifactsRoot();
await ensureArtifacts();

type TestCase = {
	file: string;
	line: number;
	name: string;
	suite: string;
};

const REGEXP_METACHARACTER_PATTERN = /[.*+?^${}()|[\]\\]/g;
const TESTCASE_PATTERN = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
const SKIPPED_TAG_PATTERN = /<skipped\b/;
const NAME_PATTERN = /\bname="([^"]*)"/;

const escapeRegExp = (value: string): string =>
	value.replace(REGEXP_METACHARACTER_PATTERN, "\\$&");

const lineIndex = new Map<string, number>();
const internLine = (key: string): number => {
	const existing = lineIndex.get(key);
	if (existing !== undefined) {
		return existing;
	}
	const id = lineIndex.size;
	lineIndex.set(key, id);
	return id;
};

const lineIdsOf = async (lcovPath: string): Promise<number[]> => {
	let text: string;
	try {
		text = await Bun.file(lcovPath).text();
	} catch {
		return [];
	}
	const ids: number[] = [];
	for (const record of parseLcov(text)) {
		for (const line of record.lines) {
			const key = applicationLineKey(record.source, line);
			if (key !== undefined) {
				ids.push(internLine(key));
			}
		}
	}
	return ids;
};

type Result = TestCase & {
	executedNames: string[];
	exitCode: number;
	key: string;
	lines: number[];
	matched: number;
	wallMs: number;
};

const runOne = async (
	testCase: TestCase & { key: string }
): Promise<Result> => {
	const directory = path.join(artifacts, "cov-tests", slug(testCase.key));
	const junitPath = `${directory}.xml`;
	const result = await runBunTest(
		[
			"test",
			"--timeout",
			String(TEST_TIMEOUT_MS),
			"--no-orphans",
			"--coverage",
			"--coverage-reporter=lcov",
			`--coverage-dir=${directory}`,
			"--reporter=junit",
			`--reporter-outfile=${junitPath}`,
			"-t",
			escapeRegExp(testCase.name),
			testCase.file,
		],
		{ cwd: root, env: testEnvironment() }
	);
	let matched = 0;
	const executedNames: string[] = [];
	const junit = Bun.file(junitPath);
	if (await junit.exists()) {
		for (const match of (await junit.text()).matchAll(TESTCASE_PATTERN)) {
			if (SKIPPED_TAG_PATTERN.test(match[3] ?? "")) {
				continue;
			}
			matched += 1;
			const name = NAME_PATTERN.exec(match[1] ?? "")?.[1];
			if (name !== undefined) {
				executedNames.push(
					name.replaceAll("&amp;", "&").replaceAll("&quot;", '"')
				);
			}
		}
		await fs.rm(junitPath, { force: true });
	}
	const lines = await lineIdsOf(path.join(directory, "lcov.info"));
	await fs.rm(directory, { force: true, recursive: true });
	return {
		...testCase,
		executedNames,
		exitCode: result.exitCode,
		lines,
		matched,
		wallMs: result.wallMs,
	};
};

const baselineEntries = await fs.readdir(path.join(artifacts, "junit"));
const label = process.argv[3] ?? baselineEntries.sort().at(0) ?? "run1";
const junitDirectory = path.join(artifacts, "junit", label);
const tests: TestCase[] = [];
for (const entry of await fs.readdir(junitDirectory)) {
	if (!entry.endsWith(".xml")) {
		continue;
	}
	for (const result of parseJunit(
		await Bun.file(path.join(junitDirectory, entry)).text()
	)) {
		tests.push({
			file: result.file,
			line: result.line,
			name: result.name,
			suite: result.suite,
		});
	}
}
const selected = tests.map((testCase, position) => ({
	...testCase,
	key: `${position}_${testCase.file}_${testCase.line}`,
}));

const output = path.join(analysisDir(), "per-test-fingerprints.jsonl");
await fs.rm(output, { force: true });
const writer = Bun.file(output).writer();
let cursor = 0;
let completed = 0;
const started = Bun.nanoseconds();

const worker = async (): Promise<void> => {
	while (cursor < selected.length) {
		const testCase = selected[cursor];
		cursor += 1;
		if (testCase === undefined) {
			return;
		}
		writer.write(`${JSON.stringify(await runOne(testCase))}\n`);
		completed += 1;
		if (completed % 100 === 0) {
			console.log(
				`${completed}/${selected.length} ${Math.round(Number(Bun.nanoseconds() - started) / 1e9)}s`
			);
		}
	}
};

await Promise.all(Array.from({ length: concurrency }, worker));
await writer.end();
await writeJson(path.join(analysisDir(), "per-test-line-index.json"), [
	...lineIndex.keys(),
]);
console.log(
	`done: ${selected.length} tests, ${lineIndex.size} application lines, ${Math.round(Number(Bun.nanoseconds() - started) / 1e9)}s`
);

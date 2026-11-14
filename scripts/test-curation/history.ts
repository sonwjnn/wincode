/**
 * Mines defect history and change pressure from git.
 *
 *   bun scripts/test-curation/history.ts
 *
 * A test file touched by a `fix:` commit has been involved in a real defect
 * cycle; a test case added by a `fix:` commit documents a real bug. Those are
 * the defect-detection inputs for tiering. Writes
 * `<artifacts>/analysis/history.json`.
 */

import * as path from "node:path";
import { $ } from "bun";
import { analysisDir, ensureArtifacts, repoRoot, writeJson } from "./lib";

const FIX_SUBJECT_PATTERN = /^fix[(!:\s]/;
const ADDED_TEST_PATTERN = /^\+\s*(?:test|it)(?:\.\w+)?\(\s*["'`](.+?)["'`]/;

const ROOT = repoRoot();
const log = await $`git log --format=%H%x09%cI%x09%s`.cwd(ROOT).text();
const commits = log
	.split("\n")
	.filter((line) => line.length > 0)
	.map((line) => {
		const [sha, date, ...subject] = line.split("\t");
		return { date: date ?? "", sha: sha ?? "", subject: subject.join("\t") };
	});
const fixCommits = commits.filter((commit) =>
	FIX_SUBJECT_PATTERN.test(commit.subject)
);

const testFileFixCounts = new Map<string, number>();
const addedTestsByFile = new Map<string, string[]>();
const appFileFixCounts = new Map<string, number>();

for (const commit of fixCommits) {
	const diff = await $`git show --unified=0 --format= --no-color ${commit.sha}`
		.cwd(ROOT)
		.nothrow()
		.text();
	let currentFile: string | undefined;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++ b/")) {
			currentFile = line.slice(6);
			if (currentFile.includes("/test/")) {
				testFileFixCounts.set(
					currentFile,
					(testFileFixCounts.get(currentFile) ?? 0) + 1
				);
			} else if (currentFile.startsWith("packages/")) {
				appFileFixCounts.set(
					currentFile,
					(appFileFixCounts.get(currentFile) ?? 0) + 1
				);
			}
			continue;
		}
		if (currentFile === undefined || !currentFile.includes("/test/")) {
			continue;
		}
		const added = ADDED_TEST_PATTERN.exec(line);
		if (added?.[1] !== undefined) {
			addedTestsByFile.set(currentFile, [
				...(addedTestsByFile.get(currentFile) ?? []),
				`${commit.sha.slice(0, 7)} ${added[1]}`,
			]);
		}
	}
}

const churn = await $`git log --since=90.days --name-only --format=`
	.cwd(ROOT)
	.text();
const churnCounts = new Map<string, number>();
for (const file of churn.split("\n")) {
	if (!file.startsWith("packages/") || file.includes("/test/")) {
		continue;
	}
	churnCounts.set(file, (churnCounts.get(file) ?? 0) + 1);
}

await ensureArtifacts();
await writeJson(path.join(analysisDir(), "history.json"), {
	addedTestsByFile: Object.fromEntries(addedTestsByFile),
	appFileFixCounts: [...appFileFixCounts.entries()]
		.sort((left, right) => right[1] - left[1])
		.slice(0, 60)
		.map(([file, fixes]) => ({
			churn: churnCounts.get(file) ?? 0,
			file,
			fixes,
		})),
	commitCount: commits.length,
	fixCommitCount: fixCommits.length,
	testFileFixCounts: [...testFileFixCounts.entries()]
		.sort((left, right) => right[1] - left[1])
		.map(([file, fixes]) => ({ file, fixes })),
	window: { newest: commits[0]?.date, oldest: commits.at(-1)?.date },
});
console.log(
	JSON.stringify(
		{
			addedTests: [...addedTestsByFile.values()].flat().length,
			commits: commits.length,
			fixCommits: fixCommits.length,
			filesWhereFixAddedTest: addedTestsByFile.size,
			testFilesInFixes: testFileFixCounts.size,
		},
		null,
		2
	)
);

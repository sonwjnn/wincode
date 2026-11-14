/**
 * Historical-defect fault injection.
 *
 *   bun scripts/test-curation/reverts.ts [--worktree <dir>]
 *
 * For each cluster, takes the `fix:` commits that ADDED tests to the cluster's
 * file (real defect cycles) and reverse-applies only their non-test changes of
 * the cluster's subject module inside the worktree. A member that fails while
 * its peer passes is not subsumed by it. Requires `analysis.ts` and the history
 * artifact. Writes `revert-injection.json`.
 */

import * as path from "node:path";
import { $ } from "bun";
import {
	analysisDir,
	createWorktree,
	ensureArtifacts,
	readJson,
	removeWorktree,
	repoRoot,
	runBunTest,
	testEnvironment,
	writeJson,
} from "./lib";

const ROOT = repoRoot();
const args = process.argv.slice(2);
const worktreeArgument = args.indexOf("--worktree");
const provided = worktreeArgument >= 0 ? args[worktreeArgument + 1] : undefined;

type Member = { file: string; line: number; name: string };
const analysis = await readJson<{
	clusterCoverage: { members: Member[]; size: number }[];
}>(path.join(analysisDir(), "coverage-analysis.json"));
const fault = await readJson<{
	results: { cluster: number; subjectFile: string }[];
}>(path.join(analysisDir(), "fault-injection.json"));
const history = await readJson<{ addedTestsByFile: Record<string, string[]> }>(
	path.join(analysisDir(), "history.json")
);

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const runMember = async (
	worktree: string,
	member: Member
): Promise<boolean> => {
	const result = await runBunTest(
		[
			"test",
			"--timeout",
			"30000",
			"--no-orphans",
			"-t",
			escapeRegExp(member.name),
			member.file,
		],
		{ cwd: worktree, env: testEnvironment() }
	);
	return result.exitCode === 0;
};
const appFilesOf = async (sha: string): Promise<string[]> =>
	(await $`git show --name-only --format= ${sha}`.cwd(ROOT).nothrow().text())
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(file) =>
				file.startsWith("packages/") &&
				!file.includes("/test/") &&
				file.length > 0
		);
const patchOf = async (sha: string, file: string): Promise<string> =>
	await $`git show --format= --no-color ${sha} -- ${file}`
		.cwd(ROOT)
		.nothrow()
		.text();

const clusters = analysis.clusterCoverage
	.map((cluster, index) => ({ cluster, index }))
	.map(({ cluster, index }) => ({
		index,
		members: cluster.members,
		subjectFile: fault.results.find((entry) => entry.cluster === index)
			?.subjectFile,
		testFile: cluster.members[0]?.file ?? "",
	}))
	.filter((entry) => entry.members.length > 1 && entry.testFile.length > 0);

const worktree = provided ?? (await createWorktree());
const results: {
	attempts: {
		killedBy: string[];
		reverted: string[];
		sha: string;
		subject: string;
		survivedBy: string[];
	}[];
	cluster: number;
	subjectFile?: string;
	testFile: string;
}[] = [];

await ensureArtifacts();
try {
	for (const cluster of clusters) {
		const attempts: (typeof results)[number]["attempts"] = [];
		const candidates = (history.addedTestsByFile[cluster.testFile] ?? [])
			.map((entry) => entry.split(" ")[0] ?? "")
			.filter((sha) => sha.length === 7);
		if (candidates.length === 0) {
			continue;
		}
		for (const shortSha of [...new Set(candidates)].slice(0, 4)) {
			const sha = (
				await $`git rev-parse ${shortSha}`.cwd(ROOT).nothrow().text()
			).trim();
			if (sha.length === 0) {
				continue;
			}
			const subject = (
				await $`git log -1 --format=%s ${sha}`.cwd(ROOT).text()
			).trim();
			const appFiles = (await appFilesOf(sha)).filter(
				(file) =>
					cluster.subjectFile === undefined || file === cluster.subjectFile
			);
			const reverted: string[] = [];
			for (const file of appFiles) {
				const patch = await patchOf(sha, file);
				if (patch.trim().length === 0) {
					continue;
				}
				const apply = Bun.spawn(["git", "apply", "-R", "--recount", "-"], {
					cwd: worktree,
					stdin: "pipe",
					stderr: "ignore",
					stdout: "ignore",
				});
				apply.stdin.write(patch);
				await apply.stdin.end();
				if ((await apply.exited) === 0) {
					reverted.push(file);
				}
			}
			if (reverted.length === 0) {
				continue;
			}
			const killedBy: string[] = [];
			const survivedBy: string[] = [];
			for (const member of cluster.members) {
				const passed = await runMember(worktree, member);
				if (passed) {
					survivedBy.push(`${member.file}:${member.line}`);
				} else {
					killedBy.push(`${member.file}:${member.line}`);
				}
			}
			attempts.push({ killedBy, reverted, sha: shortSha, subject, survivedBy });
			await $`git checkout -- ${reverted}`.cwd(worktree).nothrow();
			console.log(
				`cluster ${cluster.index} ${shortSha} reverted=${reverted.length} killed=${killedBy.length}/${cluster.members.length} ${subject.slice(0, 60)}`
			);
			if (killedBy.length > 0 && survivedBy.length > 0) {
				break;
			}
		}
		if (attempts.length > 0) {
			results.push({
				attempts,
				cluster: cluster.index,
				subjectFile: cluster.subjectFile,
				testFile: cluster.testFile,
			});
		}
	}
} finally {
	if (provided === undefined) {
		await removeWorktree(worktree);
	}
}

await writeJson(path.join(analysisDir(), "revert-injection.json"), {
	results,
	worktree,
});
const asymmetric = results.flatMap((entry) =>
	entry.attempts
		.filter(
			(attempt) => attempt.killedBy.length > 0 && attempt.survivedBy.length > 0
		)
		.map((attempt) => ({
			cluster: entry.cluster,
			killedBy: attempt.killedBy,
			sha: attempt.sha,
			survivedBy: attempt.survivedBy,
		}))
);
console.log(
	JSON.stringify(
		{
			asymmetricKills: asymmetric.length,
			attemptsWithAnyKill: results
				.flatMap((entry) => entry.attempts)
				.filter((attempt) => attempt.killedBy.length > 0).length,
			clustersAttempted: results.length,
			revertAttempts: results.reduce(
				(sum, entry) => sum + entry.attempts.length,
				0
			),
		},
		null,
		2
	)
);

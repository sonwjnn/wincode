/**
 * Operator-level fault injection for coverage-equal clusters.
 *
 *   bun scripts/test-curation/faults.ts [--worktree <dir>] [--files a.ts,b.ts]
 *
 * Bun has no mutation-testing runner here, so this swaps comparisons and
 * boolean operators on lines the cluster members already cover, runs each
 * member alone against the mutant, and records which members fail (kill) it. A
 * member that kills a mutant its peer misses is not subsumed by it.
 *
 * Mutants apply inside a detached git worktree; the live tree is never mutated.
 * Without `--worktree` one is created under `<artifacts>/worktree` and removed
 * afterwards. Requires `analysis.ts`. Writes `fault-injection.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	testEnvironment as _testEnvironment,
	analysisDir,
	createWorktree,
	ensureArtifacts,
	isReadableFile,
	readJson,
	removeWorktree,
	repoRoot,
	runBunTest,
	writeJson,
} from "./lib";

const DEFAULT_SELECTION = [
	"packages/utils/test/scalar-predicates.test.ts",
	"packages/coding-agent/test/prompt-config-provider.test.ts",
	"packages/coding-agent/test/sessions/compaction.test.ts",
	"packages/coding-agent/test/sessions/summary-generator.test.ts",
	"packages/coding-agent/test/application/plugin-registry.test.ts",
	"packages/ai/test/sdk-opencode-go-provider.test.ts",
	"packages/coding-agent/test/application/cli-startup.test.ts",
];
const OPERATORS: [string, string][] = [
	["===", "!=="],
	["!==", "==="],
	["<=", "<"],
	[">=", ">"],
	["&&", "||"],
	["||", "&&"],
];
const ROOT = repoRoot();

type Member = { file: string; line: number; name: string };
type ClusterReport = {
	members: Member[];
	size: number;
};
type Row = { file: string; line: number; lines: number[]; name: string };

const args = process.argv.slice(2);
const worktreeArgument = args.indexOf("--worktree");
const filesArgument = args.indexOf("--files");
const selectedFiles =
	filesArgument >= 0
		? (args[filesArgument + 1] ?? "").split(",").filter(Boolean)
		: DEFAULT_SELECTION;

await ensureArtifacts();
const directory = analysisDir();
const rows: Row[] = (
	await Bun.file(path.join(directory, "per-test-fingerprints.jsonl")).text()
)
	.split("\n")
	.filter((entry) => entry.length > 0)
	.map((entry) => JSON.parse(entry) as Row);
const lineIndex = await readJson<string[]>(
	path.join(directory, "per-test-line-index.json")
);
const analysis = await readJson<{ clusterCoverage: ClusterReport[] }>(
	path.join(directory, "coverage-analysis.json")
);
const rowByKey = new Map(
	rows.map((row) => [`${row.file}:${row.line}:${row.name}`, row])
);
const keyOf = (member: Member): string =>
	`${member.file}:${member.line}:${member.name}`;

const escapeRegExp = (value: string): string =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const runTest = async (worktree: string, member: Member): Promise<boolean> => {
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
		{ cwd: worktree, env: _testEnvironment() }
	);
	return result.exitCode === 0;
};

const clusters = analysis.clusterCoverage
	.map((cluster, index) => ({ cluster, index }))
	.filter(({ cluster }) =>
		cluster.members.some((member) => selectedFiles.includes(member.file))
	);

const provided = worktreeArgument >= 0 ? args[worktreeArgument + 1] : undefined;
const worktree = provided ?? (await createWorktree());
const results: {
	cluster: number;
	mutants: {
		from: string;
		killedBy: string[];
		line: number;
		source: string;
		survivedBy: string[];
		to: string;
	}[];
	pairs: {
		left: string;
		leftOnly: number;
		right: string;
		rightOnly: number;
		sharedKills: number;
	}[];
	subjectFile: string;
	testFile: string;
}[] = [];

try {
	for (const { cluster, index } of clusters) {
		const members = cluster.members.filter((member) =>
			selectedFiles.includes(member.file)
		);
		const testFile = members[0]?.file;
		if (members.length < 2 || testFile === undefined) {
			continue;
		}
		const fileCounts = new Map<string, number>();
		for (const member of members) {
			const row = rowByKey.get(keyOf(member));
			for (const id of row?.lines ?? []) {
				const lineKey = lineIndex[id];
				if (lineKey === undefined) {
					continue;
				}
				const file = lineKey.slice(0, lineKey.lastIndexOf(":"));
				fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1);
			}
		}
		// Prefer a module the test imports directly; raw coverage share otherwise
		// picks shared utilities that only appear through the import graph.
		const imports = new Set<string>();
		for (const member of members) {
			const source = await Bun.file(path.join(ROOT, member.file)).text();
			for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
				const specifier = match[1];
				if (specifier === undefined) {
					continue;
				}
				let base: string | undefined;
				if (specifier.startsWith("@/")) {
					base = path.posix.join("packages/coding-agent", specifier.slice(2));
				} else if (specifier.startsWith(".")) {
					base = path.posix.join(path.posix.dirname(member.file), specifier);
				}
				if (base === undefined) {
					continue;
				}
				for (const extension of [
					"",
					".ts",
					".tsx",
					"/index.ts",
					"/index.tsx",
				]) {
					const candidate = `${base}${extension}`;
					if (await isReadableFile(path.join(ROOT, candidate))) {
						imports.add(candidate);
						break;
					}
				}
			}
		}
		const imported = [...fileCounts.entries()]
			.filter(([file]) => imports.has(file))
			.sort((left, right) => right[1] - left[1]);
		const subjectFile =
			imported[0]?.[0] ??
			[...fileCounts.entries()].sort(
				(left, right) => right[1] - left[1]
			)[0]?.[0];
		if (subjectFile === undefined) {
			continue;
		}
		const coveredLines = new Set<number>();
		for (const member of members) {
			for (const id of rowByKey.get(keyOf(member))?.lines ?? []) {
				const lineKey = lineIndex[id];
				if (lineKey?.startsWith(`${subjectFile}:`)) {
					coveredLines.add(Number(lineKey.slice(subjectFile.length + 1)));
				}
			}
		}
		const original = await fs.readFile(
			path.join(worktree, subjectFile),
			"utf8"
		);
		const sourceLines = original.split("\n");
		const candidates: {
			from: string;
			line: number;
			source: string;
			to: string;
		}[] = [];
		for (const line of [...coveredLines].sort((left, right) => left - right)) {
			const text = sourceLines[line - 1];
			if (text === undefined) {
				continue;
			}
			for (const [from, to] of OPERATORS) {
				if (text.includes(from)) {
					candidates.push({ from, line, source: text.trim(), to });
					break;
				}
			}
			if (candidates.length >= 8) {
				break;
			}
		}
		const mutants: (typeof results)[number]["mutants"] = [];
		for (const candidate of candidates) {
			const mutated = [...sourceLines];
			const target = mutated[candidate.line - 1];
			if (target === undefined) {
				continue;
			}
			mutated[candidate.line - 1] = target.replace(
				candidate.from,
				candidate.to
			);
			if (mutated[candidate.line - 1] === target) {
				continue;
			}
			await fs.writeFile(path.join(worktree, subjectFile), mutated.join("\n"));
			const killedBy: string[] = [];
			const survivedBy: string[] = [];
			for (const member of members) {
				const passed = await runTest(worktree, member);
				if (passed) {
					survivedBy.push(`${member.file}:${member.line}`);
				} else {
					killedBy.push(`${member.file}:${member.line}`);
				}
			}
			mutants.push({ ...candidate, killedBy, survivedBy });
			await fs.writeFile(path.join(worktree, subjectFile), original);
			console.log(
				`cluster ${index} ${subjectFile}:${candidate.line} ${candidate.from}->${candidate.to} killed ${killedBy.length}/${members.length}`
			);
		}
		const pairs: (typeof results)[number]["pairs"] = [];
		for (let index_ = 0; index_ < members.length; index_ += 1) {
			for (let other = index_ + 1; other < members.length; other += 1) {
				const left = members[index_];
				const right = members[other];
				if (left === undefined || right === undefined) {
					continue;
				}
				const leftId = `${left.file}:${left.line}`;
				const rightId = `${right.file}:${right.line}`;
				pairs.push({
					left: leftId,
					leftOnly: mutants.filter(
						(mutant) =>
							mutant.killedBy.includes(leftId) &&
							!mutant.killedBy.includes(rightId)
					).length,
					right: rightId,
					rightOnly: mutants.filter(
						(mutant) =>
							!mutant.killedBy.includes(leftId) &&
							mutant.killedBy.includes(rightId)
					).length,
					sharedKills: mutants.filter(
						(mutant) =>
							mutant.killedBy.includes(leftId) &&
							mutant.killedBy.includes(rightId)
					).length,
				});
			}
		}
		results.push({ cluster: index, mutants, pairs, subjectFile, testFile });
	}
} finally {
	if (provided === undefined) {
		await removeWorktree(worktree);
	}
}

await writeJson(path.join(directory, "fault-injection.json"), {
	results,
	worktree,
});
console.log(
	JSON.stringify(
		{
			clusters: results.length,
			mutants: results.reduce((sum, entry) => sum + entry.mutants.length, 0),
			pairsCompared: results.reduce(
				(sum, entry) => sum + entry.pairs.length,
				0
			),
			pairsWithAsymmetricKills: results
				.flatMap((entry) => entry.pairs)
				.filter((pair) => pair.leftOnly > 0 || pair.rightOnly > 0).length,
		},
		null,
		2
	)
);

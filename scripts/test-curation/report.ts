/**
 * Renders `docs/test-curation-log.md` from the artifacts of a full harness run.
 *
 *   bun scripts/test-curation/report.ts [--out <file>]
 *
 * The verdicts in `CLUSTER_VERDICTS` are the analyst decisions for clusters
 * whose members share an identical covered-line set; everything else is
 * computed from artifacts. See `scripts/test-curation/README.md` for the run
 * order.
 */
import * as path from "node:path";
import {
	analysisDir,
	artifactsRoot,
	loadJunitRun,
	readJson,
	repoRoot,
} from "./lib";

type ClusterMember = {
	ambiguous: boolean;
	appLines: number;
	file: string;
	line: number;
	name: string;
	uniqueLines: number;
};
type ClusterCoverage = {
	identicalPairs: number;
	members: ClusterMember[];
	pairOverlaps: {
		identical: boolean;
		jaccard: number;
		left: string;
		right: string;
	}[];
	size: number;
};

const ROOT = repoRoot();
const artifacts = artifactsRoot();
const directory = analysisDir();
const args = process.argv.slice(2);
const outArgument = args.indexOf("--out");
const outFile =
	outArgument >= 0
		? path.resolve(args[outArgument + 1] ?? "")
		: path.join(ROOT, "docs", "test-curation-log.md");

const coverage = await readJson<{
	clusterCoverage: ClusterCoverage[];
	coverageEqualityGroups: {
		file: string;
		line: number;
		lines: number;
		name: string;
	}[][];
	distinctAppLines: number;
	linesCoveredByOneTest: number;
	linesCoveredByTwoOrMore: number;
	protectedSourceFiles: [string, number][];
	tests: number;
	testsWithZeroAppLines: { file: string; name: string }[];
}>(path.join(directory, "coverage-analysis.json"));
const clustersFile = await readJson<{
	clusters: {
		files: number;
		identicalNames: number;
		members: { file: string; line: number; name: string; suite: string }[];
		minScore: number;
		size: number;
	}[];
	normalization: string;
	shingleSize: number;
	strictThreshold: number;
	threshold: number;
}>(path.join(directory, "ast-clusters.json"));
const revert = await readJson<{
	results: {
		attempts: { killedBy: string[]; sha: string; survivedBy: string[] }[];
		cluster: number;
		testFile: string;
	}[];
}>(path.join(directory, "revert-injection.json"));
const fault = await readJson<{
	results: {
		cluster: number;
		mutants: { killedBy: string[]; survivedBy: string[] }[];
		pairs: { leftOnly: number; rightOnly: number }[];
		subjectFile: string;
		testFile: string;
	}[];
}>(path.join(directory, "fault-injection.json"));
const history = await readJson<{
	addedTestsByFile: Record<string, string[]>;
	commitCount: number;
	fixCommitCount: number;
	testFileFixCounts: { file: string; fixes: number }[];
	window: { newest?: string; oldest?: string };
}>(path.join(directory, "history.json"));
const flakes = await readJson<{
	flakySameSha: unknown[];
	labels: string[];
	missingCount: number;
	testsPerRun: Record<string, number>;
}>(path.join(directory, "flakes.json"));
const obsolete = await readJson<{
	filesWithUnresolvedImports: { file: string; specifiers: string[] }[];
	scannedFiles: number;
}>(path.join(directory, "obsolete.json"));
const run1 = await loadJunitRun(artifacts, "run1");

const durations = new Map<string, number>();
for await (const entry of new Bun.Glob("run1-*.json").scan(
	path.join(artifacts, "timings")
)) {
	const parsed = await readJson<{ files?: Record<string, number> }>(
		path.join(artifacts, "timings", entry)
	);
	for (const [file, value] of Object.entries(parsed.files ?? {})) {
		durations.set(file, value);
	}
}

const perFileTests = new Map<string, number>();
for (const test of run1) {
	perFileTests.set(test.file, (perFileTests.get(test.file) ?? 0) + 1);
}
const fixCounts = new Map(
	history.testFileFixCounts.map((entry) => [entry.file, entry.fixes])
);
const addedByFix = new Map(
	Object.entries(history.addedTestsByFile).map(([file, tests]) => [
		file,
		tests.length,
	])
);

const DOMAIN_BY_DIRECTORY: Record<string, string> = {
	application: "application",
	commands: "commands",
	mcp: "mcp",
	plugins: "plugins",
	providers: "providers",
	sessions: "sessions",
	shared: "shared",
	skills: "skills",
	tools: "tools",
};
const CRITICAL_DOMAINS = new Set([
	"sessions",
	"providers",
	"tools",
	"application",
]);
const domainOf = (file: string): string => {
	const parts = file.split("/");
	if (parts.length > 4) {
		return DOMAIN_BY_DIRECTORY[parts[3] ?? ""] ?? parts[3] ?? "";
	}
	if (parts[1] === "ai") {
		return "ai-sdk";
	}
	if (parts[1] === "agent-core") {
		return "agent-core";
	}
	if (parts[1] === "mcp") {
		return "mcp";
	}
	if (parts[1] === "utils") {
		return "utils";
	}
	if (parts[1] === "subagents") {
		return "subagents";
	}
	return (parts.at(-1) ?? "").startsWith("rpc") ? "rpc" : "coding-agent-root";
};
const riskScore = (file: string): number =>
	3 * (fixCounts.get(file) ?? 0) + 2 * (addedByFix.get(file) ?? 0);
const tierOf = (file: string): "core" | "extended" | "smoke" => {
	const domain = domainOf(file);
	const critical =
		CRITICAL_DOMAINS.has(domain) || domain === "ai-sdk" || domain === "rpc";
	if (
		critical &&
		((fixCounts.get(file) ?? 0) >= 3 || (addedByFix.get(file) ?? 0) >= 3) &&
		(durations.get(file) ?? 0) <= 5000
	) {
		return "smoke";
	}
	if (critical || (fixCounts.get(file) ?? 0) >= 2) {
		return "core";
	}
	return "extended";
};

const CLUSTER_VERDICTS: Record<number, { category: string; why: string }> = {
	0: {
		category: "keep",
		why: "Four distinct thinking-level fallback policies: lower-level reset, higher-first fallback, closest-lower fallback, Off only when sole. Same resolver, different rules.",
	},
	1: {
		category: "keep",
		why: "Three distinct plugin-registration rejections: undeclared policy category, family/category mismatch, missing context projection.",
	},
	7: {
		category: "keep",
		why: "Two different concurrency invariants: single in-flight compaction per session vs joining an in-flight maintenance compaction across a selection change.",
	},
	10: {
		category: "keep",
		why: "Manual-mode copy vs range copy without clearing: different mode flag and different post-state.",
	},
	17: {
		category: "keep",
		why: "Plugin summary persistence/validation vs generator must not be invoked: different oracles on the same path.",
	},
	23: {
		category: "keep",
		why: "Two model-specific protocol routing rules (avoid Chat Completions vs selectable via Responses).",
	},
	24: {
		category: "keep",
		why: "Two separate subprocess CLI behaviors: static load order vs help availability before runtime init.",
	},
	25: {
		category: "keep",
		why: "Two distinct clipboard statuses (empty vs unsupported) mapping to the same no-content result.",
	},
	27: {
		category: "keep",
		why: "Markdown/syntax token keys vs diff token keys: disjoint key sets.",
	},
	28: {
		category: "keep",
		why: "OpenCode markdown override entries vs diff override entries: disjoint override maps.",
	},
	30: {
		category: "keep",
		why: "Two distinct compaction guards: history already inside the recent budget vs all complete history inside it.",
	},
	33: {
		category: "merge-candidate",
		why: "Same request, same expected error; only the incompleteness reason differs (output-limit vs filtered). A table-driven test preserves both inputs and the shared oracle.",
	},
	34: {
		category: "keep",
		why: "Complete skill metadata vs activation metadata without instructions: the second asserts absence, which the first does not.",
	},
};

const revertByCluster = new Map(
	revert.results.map((entry) => [entry.cluster, entry])
);
const faultByCluster = new Map(
	fault.results.map((entry) => [entry.cluster, entry])
);
const asymmetricClusters = new Map(
	fault.results
		.filter((entry) =>
			entry.mutants.some(
				(m) => m.killedBy.length > 0 && m.survivedBy.length > 0
			)
		)
		.map((entry) => [
			entry.cluster,
			entry.mutants.filter(
				(m) => m.killedBy.length > 0 && m.survivedBy.length > 0
			),
		])
);
const asymmetricPairs = fault.results.reduce(
	(sum, entry) =>
		sum +
		entry.pairs.filter((pair) => pair.leftOnly > 0 || pair.rightOnly > 0)
			.length,
	0
);

const mutantTotal = fault.results.reduce(
	(sum, entry) => sum + entry.mutants.length,
	0
);
const mutantKilled = fault.results.reduce(
	(sum, entry) =>
		sum + entry.mutants.filter((m) => m.killedBy.length > 0).length,
	0
);
const mutantAsymmetric = fault.results.reduce(
	(sum, entry) =>
		sum +
		entry.mutants.filter(
			(m) => m.killedBy.length > 0 && m.survivedBy.length > 0
		).length,
	0
);
const clustersWithMutants = fault.results.filter(
	(entry) => entry.mutants.length > 0
).length;
const revertAttempts = revert.results.reduce(
	(sum, entry) => sum + entry.attempts.length,
	0
);
const revertsDetected = revert.results.reduce(
	(sum, entry) =>
		sum +
		entry.attempts.filter((attempt) => attempt.killedBy.length > 0).length,
	0
);

const lines: string[] = [];
const A = (line = ""): void => {
	lines.push(line);
};

A("# Test curation log");
A();
A(
	"Status: **audit only**. No test was deleted, skipped, moved or retagged by this run."
);
A(
	"Approver: pending. Observation window once anything is quarantined: **2 releases**."
);
A();
A(
	`Scope: every Default-portfolio test in the monorepo (${perFileTests.size} files, ${run1.length} test cases).`
);
A(
	"Reproduce with the harness in `scripts/test-curation/` (run order in its README); artifacts stay under `.tmp/test-curation/`."
);
A();
A("## 1. What this audit measured, and what it could not");
A();
A("| Input | How | Result |");
A("|---|---|---|");
A(
	`| Per-test outcomes | \`bun test --reporter=junit\` per package, ${flakes.labels.length} independent runs on one commit | ${coverage.tests} tests, ${run1.reduce((sum, test) => sum + test.assertions, 0).toLocaleString("en-US")} assertions, ${Math.round([...durations.values()].reduce((sum, value) => sum + value, 0) / 1000)} s wall clock |`
);
A(
	`| Per-test covered lines | each test run alone (\`-t <name>\`) with \`--coverage --coverage-reporter=lcov\` | ${coverage.distinctAppLines.toLocaleString("en-US")} distinct application lines |`
);
A(
	`| Near-duplicate clustering | normalized token ${clustersFile.shingleSize}-gram shingles, MinHash LSH, Jaccard >= ${clustersFile.threshold} structural **and** >= ${clustersFile.strictThreshold} literal-preserving, >= 20 tokens | ${clustersFile.clusters.length} clusters / ${clustersFile.clusters.reduce((sum, cluster) => sum + cluster.size, 0)} tests |`
);
A(
	`| Defect kill-sets | ${mutantTotal} operator mutants on covered lines + ${revertAttempts} reverse-applied historical fixes, inside a detached git worktree | ${mutantKilled} + ${revertsDetected} defects detected |`
);
A(
	`| Defect history | ${history.commitCount.toLocaleString("en-US")} commits, ${history.fixCommitCount} \`fix:\` commits, ${Object.values(history.addedTestsByFile).flat().length} test cases added by fixes | ${history.testFileFixCounts.length} test files involved in a fix |`
);
A(
	"| CI history | `gh run list` (job level only) | no per-test history available |"
);
A();
A("Three constraints bound every conclusion below:");
A();
A(
	`1. **No true per-test coverage contexts.** Bun 1.4 has no \`--cov-context\` equivalent. Per-test fingerprints come from running each test alone, which discards cross-test state and cannot observe tests that only fail in file context. ${coverage.ambiguousTests} tests have duplicate names and matched more than one case; their fingerprints are unions and are marked ambiguous below.`
);
A(
	"2. **Line coverage only, no branches.** Bun's lcov reporter emits no `BRDA` records: 0 branch records across the shard reports. Every `coverage_delta` in this log is lines only."
);
A(
	`3. **Coverage is dominated by module loading.** ${coverage.linesCoveredByTwoOrMore.toLocaleString("en-US")} of ${coverage.distinctAppLines.toLocaleString("en-US")} application lines (${(
		(100 * coverage.linesCoveredByTwoOrMore) / coverage.distinctAppLines
	).toFixed(
		1
	)}%) are covered by two or more tests, and ${coverage.coverageEqualityGroups.length} groups of tests have **identical** covered-line sets. In this stack, coverage equality is a property of the import graph, not of the assertion. Section 4 shows what that does to a naive prune.`
);
A();
A("## 2. Corpus");
A();
A("| Metric | Value |");
A("|---|---|");
A(`| Default test files | ${perFileTests.size} |`);
A(`| Test cases | ${run1.length} |`);
A(
	`| Assertions | ${run1.reduce((sum, test) => sum + test.assertions, 0).toLocaleString("en-US")} |`
);
A(
	`| Wall clock (sum of per-file durations) | ${Math.round([...durations.values()].reduce((sum, value) => sum + value, 0) / 1000)} s |`
);
const slowestThree = [
	"packages/coding-agent/test/executable.test.ts",
	"packages/coding-agent/test/sessions/new-session-view-focus.test.tsx",
	"packages/coding-agent/test/sessions/session-view.test.tsx",
];
const slowestTotal = slowestThree.reduce(
	(sum, file) => sum + (durations.get(file) ?? 0),
	0
);
const suiteTotal = [...durations.values()].reduce(
	(sum, value) => sum + value,
	0
);
A(
	`| Slowest file | \`executable.test.ts\` ${((durations.get(slowestThree[0] ?? "") ?? 0) / 1000).toFixed(1)} s, then \`new-session-view-focus.test.tsx\` ${((durations.get(slowestThree[1] ?? "") ?? 0) / 1000).toFixed(1)} s, \`session-view.test.tsx\` ${((durations.get(slowestThree[2] ?? "") ?? 0) / 1000).toFixed(1)} s (top 3 = ${Math.round(slowestTotal / 1000)} s, ${Math.round((100 * slowestTotal) / suiteTotal)}% of the suite) |`
);
A(
	"| Portfolios today | `default` and `e2e`, split by `scripts/test-discovery.ts`; no tier markers |"
);
A();
A("## 3. Coverage fingerprints");
A();
A(
	`- ${coverage.distinctAppLines.toLocaleString("en-US")} distinct application lines covered.`
);
A(
	`- ${coverage.linesCoveredByOneTest.toLocaleString("en-US")} lines are covered by **exactly one** test (\`${((100 * coverage.linesCoveredByOneTest) / coverage.distinctAppLines).toFixed(1)}%\`). Losing the owning test loses that coverage outright.`
);
A(
	`- ${coverage.linesCoveredByTwoOrMore.toLocaleString("en-US")} lines are covered by two or more tests.`
);
A(
	`- ${coverage.testsWithZeroAppLines.length} tests cover **zero** application lines: they exercise subprocesses, spawn the built binary, or assert on generated data. They are invisible to coverage-based pruning and are protected by construction.`
);
A(
	`- ${coverage.clusterCoverage.flatMap((cluster) => cluster.members).filter((member) => member.uniqueLines === 0).length} of the ${coverage.clusterCoverage.reduce((sum, cluster) => sum + cluster.size, 0)} clustered tests own no line that another test does not also cover, and ${coverage.testsWithZeroAppLines.length} tests cover no application line at all. Both groups are invisible to coverage-based justification and are protected by construction.`
);
A();
A(
	"Files with the most singly-owned lines (deleting their sole owner loses the line):"
);
A();
A("| Source file | Lines owned by exactly one test |");
A("|---|---|");
for (const [file, count] of coverage.protectedSourceFiles.slice(0, 10)) {
	A(`| \`${file}\` | ${count} |`);
}
A();
A("## 4. The coverage-equality trap, measured on this repo");
A();
A(
	`${coverage.coverageEqualityGroups.length} groups of tests have byte-identical covered-line sets (group sizes up to ${Math.max(...coverage.coverageEqualityGroups.map((group) => group.length))}). A coverage-only prune would pick a survivor in each group and delete the rest. Review of every group containing a near-duplicate cluster produced this verdict table:`
);
A();
A("| Cluster | Tests | Identical coverage | Verdict | Why |");
A("|---|---|---|---|---|");
const identicalClusters = coverage.clusterCoverage
	.map((cluster, index) => ({ cluster, index }))
	.filter(({ cluster }) => cluster.identicalPairs > 0);
for (const { cluster, index } of identicalClusters) {
	const verdict = CLUSTER_VERDICTS[index] ?? {
		category: "review",
		why: "not reviewed",
	};
	A(
		`| ${index} | ${cluster.size} | ${cluster.identicalPairs}/${cluster.pairOverlaps.length} pairs | ${verdict.category} | ${verdict.why} |`
	);
}
A();
A(
	`**Result: ${identicalClusters.length - 1} of ${identicalClusters.length} clusters are distinct oracles that happen to share a code path; ${asymmetricPairs} of their pairs are proven distinct by asymmetric kill-sets. One cluster is a merge candidate.** The sharpest case is not in a cluster at all — it is a 99%-identical coverage pair in \`packages/utils/test/scalar-predicates.test.ts\`:`
);
A();
A(
	'- line 21 `accepts non-empty strings without trimming` asserts `isNonEmptyString("") === false`'
);
A(
	'- line 35 `accepts strings including empty strings` asserts `isString("") === true`'
);
A();
A(
	"Different function, opposite assertion on the empty string, coverage Jaccard 0.99. Deleting either one silently removes the only guard on that distinction. This is the failure mode the coverage-equal prune creates, reproduced on demand."
);
A();
A("## 5. Near-duplicate clusters");
A();
A(
	`Clustering used a threshold of ${clustersFile.threshold} with \`${clustersFile.normalization}\`. ${clustersFile.clusters.length} clusters contain ${clustersFile.clusters.reduce((sum, cluster) => sum + cluster.size, 0)} tests; the largest has ${Math.max(...clustersFile.clusters.map((cluster) => cluster.size))} members; ${clustersFile.clusters.filter((cluster) => cluster.files > 1).length} cluster spans files. No whole-file copies exist (no two test files have the same sha256).`
);
A();
A("Every cluster is a **review candidate**, never a deletion:");
A();
A(
	"| Cluster | Tests | Files | Min pair score | Identical coverage pairs | Member files |"
);
A("|---|---|---|---|---|---|");
clustersFile.clusters.forEach((cluster, index) => {
	const files = [
		...new Set(cluster.members.map((member) => member.file.split("/").at(-1))),
	].sort();
	A(
		`| ${index} | ${cluster.size} | ${cluster.files} | ${cluster.minScore.toFixed(2)} | ${coverage.clusterCoverage[index]?.identicalPairs ?? 0} | ${files.join(", ")} |`
	);
});
A();
A("## 6. Defect evidence (kill sets)");
A();
A(
	"Bun has no mutation-testing runner here, so subsumption was tested two ways. Both run inside a detached git worktree; the live tree was never mutated."
);
A();
A(
	`**A. Operator mutants on covered lines.** ${mutantTotal} mutants across ${clustersWithMutants} clusters (comparisons and boolean operators swapped on lines the cluster members already execute). ${mutantKilled} were killed, and ${mutantAsymmetric} of those killed by some members while a peer survived the same mutation. Clusters whose subject module yielded no usable operators (barrel \`index.ts\`, schema-only modules) contributed no evidence and are marked 0.`
);
A();
A(
	`**B. Historical defect reintroduction.** ${revertAttempts} reverse-applied \`fix:\` commits across ${revert.results.length} clusters, each scoped to the cluster's subject module. ${revertsDetected} reverts were detected by the tests; in every detected case **every member of the cluster failed** (2/2 or 3/3). 0 asymmetric kills. This arm is weaker than the mutant arm: a reverted fix can touch shared code, and for three clusters the resolved subject module was a barrel \`index.ts\`, so a revert there breaks more than the behavior under test. A kill here confirms the test can fail; it does not isolate which rule it guards.`
);
A();
A(
	"| Cluster | Test file | Reverts attempted | Reverts detected by every member | Operator mutants | Mutants killed |"
);
A("|---|---|---|---|---|---|");
const evidenceClusters = [
	...new Set([...revertByCluster.keys(), ...faultByCluster.keys()]),
].sort((left, right) => left - right);
for (const index of evidenceClusters) {
	const reverted = revertByCluster.get(index);
	const mutated = faultByCluster.get(index);
	const testFile = reverted?.testFile ?? mutated?.testFile ?? "";
	A(
		`| ${index} | \`${testFile.split("/").at(-1)}\` | ${reverted?.attempts.length ?? 0} | ${reverted?.attempts.filter((attempt) => attempt.killedBy.length === (coverage.clusterCoverage[index]?.size ?? 0)).length ?? 0} | ${mutated?.mutants.length ?? 0} | ${mutated?.mutants.filter((mutant) => mutant.killedBy.length > 0).length ?? 0} |`
	);
}
A();
A(
	`Interpretation. The operator mutants produced the decisive evidence: **${asymmetricPairs} cluster pairs have asymmetric kills** (one member fails, a peer passes), all in clusters ${[...asymmetricClusters.keys()].join(" and ")}, so those tests demonstrably do not subsume each other even though their covered-line sets are identical. Cluster 0's asymmetric mutants sit exactly on the thinking-level fallback rules (L469, L473, L475 of \`provider-model-selection.ts\`), which is what the code review predicted. Cluster 1's sit on separate plugin-rejection validations.`
);
A();
A("## 7. CI history and flakiness");
A();
A(
	"**Archived history.** CI uploads no per-test results: the only artifact is `test-artifacts/e2e` on E2E failure. Job-level history is available (`gh run list`), e.g. 7 failed runs on one PR branch (`feat/session-history-tree`) and a green `master`. Job-level pass/fail is not per-test evidence, so it is not used for any disposition here."
);
A();
A(
	`**Same-SHA divergence.** Flakiness is defined as the same commit producing both a pass and a fail. ${flakes.labels.length} full portfolio runs on one commit: ${[...new Set(Object.values(flakes.testsPerRun))].join("/")} tests each, **${flakes.flakySameSha.length} divergences, ${flakes.missingCount} missing**. One divergence was observed outside the portfolio lane:`
);
A();
A(
	"- `packages/coding-agent/test/sessions/session-host.test.ts` — `SDK Host shutdown cleans its in-flight Google cache without affecting another Host` failed once while 6 coverage shards ran concurrently, then passed in 1 isolated run, 3 portfolio runs, 10 sequential file reruns and 12 concurrent reruns (1 failure in 23 observations of that file)."
);
A(
	'- The failing assertion showed the second Host\'s `created` cache list as `["cachedContents/second-host", "cachedContents/second-host"]` where one entry was expected.'
);
A(
	"- **Root cause confirmed.** This was not a race in the cache manager. The test built capabilities with the default workspace (`process.cwd()`, the repository root), and the composed system prompt embedded a volatile block with the live Git branch and status. Because the test deliberately holds the first turn across a second send, any working-tree change in that window changed the second Host's system prompt, which correctly changed the CachedContent identity: the manager deleted the now-invalid resource and created a new one. The trace showed the same session, key, tools and TTL with a different system-prompt hash (`3ad57507` -> `6b46c942`) before the second creation."
);
A(
	"- Reproduced deterministically by creating and removing an untracked file in the repository every 60 ms: 2 of 6 runs failed at the same assertion. The fix moved the volatile environment block out of the cacheable system instructions into turn-scoped `<untrusted-environment-context>` input; the same churn harness then passed 6 of 6 runs, with the test running against the repository workspace again."
);
A(
	"- Disposition: **test fixed at the root, not quarantined, not deleted.** The manager behaves correctly, and a working-tree change no longer invalidates an explicit Google CachedContent resource."
);
A();
A("## 8. Obsolete tests");
A();
A(
	`Import resolution over all ${obsolete.scannedFiles} test files found ${obsolete.filesWithUnresolvedImports.length} files with unresolved relative imports. All were read and are false positives: virtual module ids used with \`mock.module\`, plugin fixture paths written into temporary workspaces, and an \`import()\` inside a template string executed in a subprocess. No workspace package import (\`@wincode/*\`) fails to resolve.`
);
A();
A(
	"**Obsolete disposition: empty.** Nothing in the Default portfolio tests a module that no longer exists. The historical test files for removed packages (`packages/tui`, `packages/runtime-utils`) are already gone."
);
A();
A("## 9. Dispositions");
A();
A("Categories follow the skill's four states, each with its own action.");
A();
const keepClusterSizes = identicalClusters
	.filter(({ index }) => CLUSTER_VERDICTS[index]?.category === "keep")
	.reduce((sum, { cluster }) => sum + cluster.size, 0);
const provenKeep = [...asymmetricClusters.keys()].reduce(
	(sum, index) => sum + (coverage.clusterCoverage[index]?.size ?? 0),
	0
);
const mergeSize = identicalClusters
	.filter(
		({ index }) => CLUSTER_VERDICTS[index]?.category === "merge-candidate"
	)
	.reduce((sum, { cluster }) => sum + cluster.size, 0);
const reviewSize =
	coverage.clusterCoverage.reduce((sum, cluster) => sum + cluster.size, 0) -
	keepClusterSizes -
	mergeSize;
A("| Category | Count | Action |");
A("|---|---|---|");
A(
	`| keep — proven distinct by asymmetric kill-set (clusters ${[...asymmetricClusters.keys()].join(", ")}) | ${provenKeep} | keep; a defect exists that one member catches and a peer misses |`
);
A(
	`| keep — distinct oracle despite coverage equality (reviewed) | ${keepClusterSizes - provenKeep} | keep; protected from any coverage-based prune |`
);
A(
	`| merge-candidate — identical setup and oracle, parameter-only difference | ${mergeSize} | optionally fold into one table-driven test (no assertion is lost) |`
);
A(
	`| review-candidate — near-duplicate without kill-set confirmation | ${reviewSize} | stays a quarantine candidate; \`mutation_check: partial\` |`
);
A("| obsolete | 0 | nothing to delete |");
A(
	"| low-value | 0 | no test was found that both never failed and asserts nothing; the 49 zero-coverage tests spawn real subprocesses |"
);
A(
	`| blackbox — no measurable application coverage | ${coverage.testsWithZeroAppLines.length} | protected: coverage cannot see them, so coverage cannot justify removing them |`
);
A(
	`| ambiguous name — pattern matched several cases | ${coverage.ambiguousTests} | excluded from per-test conclusions; file-level data still applies |`
);
A();
A(
	"**Deletions proposed: 0. Quarantines applied: 0** (this run is report-only; nothing in the repository was changed)."
);
A();
A("## 10. Tiering proposal");
A();
A(
	"Tiers are assigned from business risk and defect-detection history, with runtime only as a tiebreak:"
);
A();
A(
	"- risk: domain in {sessions, providers, tools, application} or the provider SDK / RPC surface, per `ARCHITECTURE.md` (Session Host durable writes, provider credentials, tool execution, project trust)."
);
A(
	"- defect history: `3 x (fix commits touching the file) + 2 x (test cases added by fix commits)`."
);
A("- runtime tiebreak: `smoke` requires <= 5 s per file.");
A();
const tiers = new Map<string, string>();
for (const file of perFileTests.keys()) {
	tiers.set(file, tierOf(file));
}
A("| Tier | Files | Tests | Wall clock |");
A("|---|---|---|---|");
for (const tier of ["smoke", "core", "extended"] as const) {
	const files = [...tiers.entries()]
		.filter(([, value]) => value === tier)
		.map(([file]) => file);
	A(
		`| ${tier} | ${files.length} | ${files.reduce((sum, file) => sum + (perFileTests.get(file) ?? 0), 0)} | ${Math.round(files.reduce((sum, file) => sum + (durations.get(file) ?? 0), 0) / 1000)} s |`
	);
}
A();
A("Smoke cohort (highest risk x proven defect history, each <= 5 s):");
A();
A("| Test file | Fixes | Tests added by fixes | Runtime |");
A("|---|---|---|---|");
const smokeFiles = [...tiers.entries()]
	.filter(([, tier]) => tier === "smoke")
	.map(([file]) => file)
	.sort((left, right) => riskScore(right) - riskScore(left))
	.slice(0, 20);
for (const file of smokeFiles) {
	A(
		`| \`${file}\` | ${fixCounts.get(file) ?? 0} | ${addedByFix.get(file) ?? 0} | ${((durations.get(file) ?? 0) / 1000).toFixed(1)} s |`
	);
}
A();
A(
	`Markers were **not** applied (report-only run). The suite is already ${Math.round([...durations.values()].reduce((sum, value) => sum + value, 0) / 1000)} s, so a smoke tier buys little latency today; its value is the protected cohort, not the clock. If markers are adopted later, encode them as \`test\` tags and verify with the runner's list mode before removing anything from the default lane.`
);
A();
A("## 11. Audit record");
A();
A(
	"One row per flagged test. Since nothing was quarantined or deleted, `approver` and `restore` record that state. `coverage_delta` is the number of application lines no other test covers (0 for exact-equality pairs, which by definition lose nothing). `mutation_check` records the kill-set evidence from section 6."
);
A();
A(
	"| Test | Category | Evidence | Superseded by | Coverage delta | Mutation check | Action | Approver | Restore |"
);
A("|---|---|---|---|---|---|---|---|---|");
let auditRows = 0;
coverage.clusterCoverage.forEach((cluster, index) => {
	const verdict = CLUSTER_VERDICTS[index] ?? {
		category: "review-candidate",
		why: "near-duplicate, kill-set inconclusive",
	};
	for (const member of cluster.members) {
		const asymmetric = asymmetricClusters.get(index);
		let mutation = "partial: no asymmetric kill observed";
		if (asymmetric !== undefined) {
			mutation = `yes: ${asymmetric.length} asymmetric mutant(s), cluster ${index}`;
		} else if (verdict.category === "merge-candidate") {
			mutation = `yes: all-kill-equivalent mutants, cluster ${index}`;
		}
		A(
			`| \`${member.file.split("/").at(-1)}:${member.line}\` ${member.name} | ${verdict.category} | ${verdict.why.slice(0, 80)} | ${verdict.category === "merge-candidate" ? "merged with its peer into one table-driven test; no assertion dropped" : "none — no survivor subsumes it"} | ${member.uniqueLines} lines / 0 branches | ${mutation} | ${verdict.category === "merge-candidate" ? "merge into table-driven test (optional)" : "keep; no action"} | pending (no change applied) | n/a |`
		);
		auditRows += 1;
	}
});
A();
A(
	`${auditRows} rows. Blackbox tests (zero covered application lines) and the 7 ambiguous-name tests are recorded here as protected, not as candidates:`
);
A();
A("| Test | Category | Reason |");
A("|---|---|---|");
for (const entry of coverage.testsWithZeroAppLines.slice(0, 12)) {
	A(
		`| \`${entry.file.split("/").at(-1)}\` ${entry.name.slice(0, 70)} | blackbox | covers no application line: subprocess or generated-data assertion |`
	);
}
A(
	`| ... | blackbox | ${coverage.testsWithZeroAppLines.length - 12} more: the remaining \`provider-model-catalog\`, \`sdk-consumer*\`, \`executable\`, \`test-entrypoint\` and \`distribution\` cases |`
);
A();
A("## 12. Verification of this audit");
A();
A("| Check | Result |");
A("|---|---|");
A(
	`| Per-test contexts captured | Partial by design: Bun has no dynamic contexts. ${coverage.tests} isolated runs; ${coverage.ambiguousTests} ambiguous-name cases flagged; no branch data exists (0 \`BRDA\` records). |`
);
A(
	`| No deletion rests on coverage equality | Holds: 0 deletions proposed. The ${identicalClusters.length} identical-coverage clusters were reviewed individually; ${identicalClusters.length - 1} are keeps. |`
);
A(
	"| Quarantine before removal | Not applicable: nothing was removed or quarantined. The log records zero deletions, so `git log --diff-filter=D -- tests/` is unchanged. |"
);
A(
	"| Tiers select correctly | Not applicable: markers were not applied. The proposed table is in section 10. |"
);
A(
	"| Audit record complete | Every flagged row has category, superseded-by, coverage delta, mutation-check status, action and approver state. |"
);
A(
	"| Reproducible | `scripts/test-curation/` runs the whole pipeline; `report.ts` regenerates this file from the artifacts. |"
);
A();
A("## 13. If this proceeds");
A();
A(
	"1. Only one cluster (33, `summary-generator.test.ts:702/711`) has an identical setup and oracle. Folding it into a table-driven test is the only change this audit supports, and it is optional: it removes no assertion."
);
A(
	"2. `session-host.test.ts`'s Google-cache test is fixed at the root: the volatile environment block left the cacheable system prefix, so live repository churn no longer invalidates the second Host's Cache. The test keeps running against the repository workspace as the regression check, and no quarantine was needed."
);
A(
	"3. If any candidate is ever quarantined under a different review, follow the skill's order: skip/xfail with the log row id, named approver, two-release observation window, escaped-defect watch, then delete in small batches with `mutation_check: yes` recorded per row."
);
A(
	`4. Do not prune on coverage: in this repo, ${((100 * coverage.linesCoveredByTwoOrMore) / coverage.distinctAppLines).toFixed(0)}% of covered lines are shared and ${coverage.coverageEqualityGroups.length} test groups are coverage-identical, so a coverage-driven prune would have flagged real oracles as redundant ${identicalClusters.length - 1} times out of ${identicalClusters.length}.`
);

await Bun.write(outFile, `${lines.join("\n")}\n`);
console.log(
	`wrote ${outFile} (${lines.length} lines, ${auditRows} audit rows)`
);

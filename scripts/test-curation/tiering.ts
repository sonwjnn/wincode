import type { TestTier } from "../test-discovery";

/**
 * Tier assignment for the Default portfolio: business risk first, defect
 * detection history second, runtime only as a tiebreak. The same function backs
 * the audit log table and the committed `scripts/test-tiers.json` manifest, so
 * the two can never disagree about which cohort a file belongs to.
 */

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
const SMOKE_RUNTIME_LIMIT_MS = 5000;

export const domainOf = (file: string): string => {
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

export type TestTierInputs = Readonly<{
	addedTestsByFile: Readonly<Record<string, readonly unknown[]>>;
	durationsMs: ReadonlyMap<string, number>;
	files: readonly string[];
	testFileFixCounts: readonly Readonly<{ file: string; fixes: number }>[];
}>;

export type TestTierScores = Readonly<{
	addedByFix: (file: string) => number;
	fixes: (file: string) => number;
	risk: (file: string) => number;
}>;

/** Risk weight used to rank smoke candidates and break tier ties. */
export const scoreTestTiers = (inputs: TestTierInputs): TestTierScores => {
	const fixes = new Map(
		inputs.testFileFixCounts.map((entry) => [entry.file, entry.fixes])
	);
	const added = new Map(
		Object.entries(inputs.addedTestsByFile).map(([file, tests]) => [
			file,
			tests.length,
		])
	);
	const fixesOf = (file: string): number => fixes.get(file) ?? 0;
	const addedOf = (file: string): number => added.get(file) ?? 0;
	return {
		addedByFix: addedOf,
		fixes: fixesOf,
		risk: (file: string): number => 3 * fixesOf(file) + 2 * addedOf(file),
	};
};

export const assignTestTiers = (
	inputs: TestTierInputs
): ReadonlyMap<string, TestTier> => {
	const scores = scoreTestTiers(inputs);
	const tierOf = (file: string): TestTier => {
		const domain = domainOf(file);
		const critical =
			CRITICAL_DOMAINS.has(domain) || domain === "ai-sdk" || domain === "rpc";
		const defectHistory =
			scores.fixes(file) >= 3 || scores.addedByFix(file) >= 3;
		const fast = (inputs.durationsMs.get(file) ?? 0) <= SMOKE_RUNTIME_LIMIT_MS;
		if (critical && defectHistory && fast) {
			return "smoke";
		}
		if (critical || scores.fixes(file) >= 2) {
			return "core";
		}
		return "extended";
	};
	const tiers = new Map<string, TestTier>();
	for (const file of inputs.files) {
		tiers.set(file, tierOf(file));
	}
	return tiers;
};

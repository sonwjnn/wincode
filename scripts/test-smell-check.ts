import * as fs from "node:fs";
import * as path from "node:path";
import {
	compareStableStrings,
	discoverTestSupportFiles,
	discoverTests,
} from "./test-discovery";

/**
 * Fixed-wait ratchet for the test tree.
 *
 * A fixed wait (`Bun.sleep(20)`, `setTimeout`, `waitForTimeout`) is only a
 * synchronization guess: it passes until the machine is slower or faster than
 * the author assumed. The reviewed suite already contains a baseline number of
 * them, so a blanket ban would fail every run. Instead the current counts are
 * recorded as a baseline and the check fails only when a file gains new fixed
 * waits. A test that removes a wait lowers the number, and `--update` locks the
 * improvement in.
 *
 * Both test files and the shared helpers under the same `test` tree are
 * scanned: a wait in `test/support/opentui.ts` gates every file that imports it,
 * so leaving helpers out let the framework-wide synchronization be a number the
 * gate never saw.
 */

const FIXED_WAIT_PATTERN = /\b(?:Bun\.sleep|waitForTimeout|setTimeout)\s*\(/g;

export type FixedWaitBaseline = Readonly<{
	counts: Readonly<Record<string, number>>;
	version: 1;
}>;

export type FixedWaitFinding = Readonly<{
	baselineCount: number;
	count: number;
	file: string;
	lines: readonly number[];
}>;

export type FixedWaitReport = Readonly<{
	findings: readonly FixedWaitFinding[];
	scannedFiles: number;
}>;

export const DEFAULT_BASELINE_PATH = "docs/test-smell-baseline.json";

const lineNumbersOf = (source: string): readonly number[] => {
	const lines: number[] = [];
	const matches = source.matchAll(FIXED_WAIT_PATTERN);
	for (const match of matches) {
		const index = match.index ?? 0;
		let lineNumber = 1;
		for (let position = 0; position < index; position += 1) {
			if (source.charCodeAt(position) === 10) {
				lineNumber += 1;
			}
		}
		lines.push(lineNumber);
	}
	return lines;
};

export const loadFixedWaitBaseline = (root: string): FixedWaitBaseline => {
	const baselinePath = path.join(root, DEFAULT_BASELINE_PATH);
	if (!fs.existsSync(baselinePath)) {
		return { counts: {}, version: 1 };
	}
	const parsed: unknown = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("counts" in parsed) ||
		typeof parsed.counts !== "object" ||
		parsed.counts === null
	) {
		throw new Error(
			`${DEFAULT_BASELINE_PATH} must contain a counts object mapping test paths to fixed-wait counts.`
		);
	}
	const counts: Record<string, number> = {};
	for (const [file, count] of Object.entries(
		parsed.counts as Record<string, unknown>
	)) {
		if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
			throw new Error(
				`${DEFAULT_BASELINE_PATH} has a non-negative integer count missing for ${file}.`
			);
		}
		counts[file] = count;
	}
	return { counts, version: 1 };
};

const toRecordedPath = (root: string, filePath: string): string =>
	path.relative(root, path.resolve(root, filePath)).split(path.sep).join("/");

const toReadablePath = (root: string, filePath: string): string =>
	path.resolve(root, filePath);

/** Every file the ratchet owns: discovered tests plus shared test-tree helpers. */
const scannedTestTreeFiles = (root: string): readonly string[] => [
	...discoverTests(root).files.map((file) => file.path),
	...discoverTestSupportFiles(root),
];

export const collectFixedWaitCounts = (
	root: string
): Readonly<Record<string, number>> => {
	const counts: Record<string, number> = {};
	for (const relativePath of scannedTestTreeFiles(root)) {
		const lines = lineNumbersOf(
			fs.readFileSync(toReadablePath(root, relativePath), "utf8")
		);
		if (lines.length > 0) {
			counts[toRecordedPath(root, relativePath)] = lines.length;
		}
	}
	return counts;
};

export const evaluateFixedWaits = (
	root: string,
	baseline: FixedWaitBaseline
): FixedWaitReport => {
	const findings: FixedWaitFinding[] = [];
	const scanned = scannedTestTreeFiles(root);
	for (const relativePath of scanned) {
		const recordedPath = toRecordedPath(root, relativePath);
		const lines = lineNumbersOf(
			fs.readFileSync(toReadablePath(root, relativePath), "utf8")
		);
		const baselineCount = baseline.counts[recordedPath] ?? 0;
		if (lines.length > baselineCount) {
			findings.push({
				baselineCount,
				count: lines.length,
				file: recordedPath,
				lines: lines.slice(baselineCount),
			});
		}
	}
	return {
		findings: [...findings].sort((left, right) =>
			compareStableStrings(left.file, right.file)
		),
		scannedFiles: scanned.length,
	};
};

export const formatFixedWaitReport = (report: FixedWaitReport): string => {
	if (report.findings.length === 0) {
		return `Fixed-wait ratchet holds across ${report.scannedFiles} test-tree files.`;
	}
	const lines = [
		`${report.findings.length} test-tree file(s) gained a fixed wait:`,
	];
	for (const finding of report.findings) {
		lines.push(
			`  ${finding.file}: ${finding.count} fixed wait(s), baseline ${finding.baselineCount} (new at line ${finding.lines.join(", ")})`
		);
	}
	lines.push(
		"Replace the wait with an explicit signal (a deferred promise or a polling loop with a deadline), or record the new budget with `bun scripts/test-smell-check.ts --update`."
	);
	return lines.join("\n");
};

const writeBaseline = (root: string): void => {
	const counts = collectFixedWaitCounts(root);
	const ordered: Record<string, number> = {};
	for (const file of Object.keys(counts).sort(compareStableStrings)) {
		const count = counts[file];
		if (count !== undefined) {
			ordered[file] = count;
		}
	}
	const baseline = `${JSON.stringify({ counts: ordered, version: 1 }, null, "\t")}\n`;
	fs.writeFileSync(path.join(root, DEFAULT_BASELINE_PATH), baseline);
};

if (import.meta.main) {
	const root = process.cwd();
	if (process.argv.includes("--update")) {
		writeBaseline(root);
		process.stdout.write(`Recorded ${DEFAULT_BASELINE_PATH}.\n`);
	} else {
		const report = evaluateFixedWaits(root, loadFixedWaitBaseline(root));
		process.stdout.write(`${formatFixedWaitReport(report)}\n`);
		process.exit(report.findings.length === 0 ? 0 : 1);
	}
}

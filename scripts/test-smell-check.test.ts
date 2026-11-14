import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectFixedWaitCounts,
	DEFAULT_BASELINE_PATH,
	evaluateFixedWaits,
	type FixedWaitBaseline,
	formatFixedWaitReport,
	loadFixedWaitBaseline,
} from "./test-smell-check";

const repoRoot = path.join(import.meta.dir, "..");

const writeTestFile = (
	root: string,
	relativePath: string,
	source: string
): void => {
	const filePath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, source);
};

const createFixtureRoot = (): string => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-smell-check-"));
	fs.mkdirSync(path.join(root, "packages", "demo", "test"), {
		recursive: true,
	});
	return root;
};

const sleepsTwice = [
	'import { test } from "bun:test";',
	"test('first', async () => {",
	"	await Bun.sleep(20);",
	"	await Bun.sleep(20);",
	"});",
].join("\n");

describe("fixed-wait ratchet", () => {
	test("fails a test file that gains a fixed wait beyond its baseline", () => {
		const root = createFixtureRoot();
		writeTestFile(root, "packages/demo/test/chat.test.ts", sleepsTwice);
		const baseline: FixedWaitBaseline = {
			counts: { "packages/demo/test/chat.test.ts": 1 },
			version: 1,
		};

		const report = evaluateFixedWaits(root, baseline);

		expect(report.findings).toEqual([
			{
				baselineCount: 1,
				count: 2,
				file: "packages/demo/test/chat.test.ts",
				lines: [4],
			},
		]);
		expect(formatFixedWaitReport(report)).toContain("new at line 4");
	});

	test("treats an unrecorded file with a fixed wait as a regression", () => {
		const root = createFixtureRoot();
		writeTestFile(root, "packages/demo/test/chat.test.ts", sleepsTwice);

		const report = evaluateFixedWaits(root, { counts: {}, version: 1 });

		expect(report.findings).toHaveLength(1);
		expect(report.findings[0]).toMatchObject({ baselineCount: 0, count: 2 });
	});

	test("passes when a file stays at or below its recorded count", () => {
		const root = createFixtureRoot();
		writeTestFile(root, "packages/demo/test/chat.test.ts", sleepsTwice);

		const report = evaluateFixedWaits(root, {
			counts: { "packages/demo/test/chat.test.ts": 2 },
			version: 1,
		});

		expect(report.findings).toEqual([]);
		expect(report.scannedFiles).toBe(1);
		expect(formatFixedWaitReport(report)).toBe(
			"Fixed-wait ratchet holds across 1 test files."
		);
	});

	test("rejects a baseline entry that is not a non-negative integer", () => {
		const root = createFixtureRoot();
		writeTestFile(
			root,
			DEFAULT_BASELINE_PATH,
			JSON.stringify({ counts: { "a.test.ts": -1 }, version: 1 })
		);

		expect(() => loadFixedWaitBaseline(root)).toThrow(
			"non-negative integer count missing for a.test.ts"
		);
	});

	test("collects the counts an updated baseline records", () => {
		const root = createFixtureRoot();
		writeTestFile(root, "packages/demo/test/chat.test.ts", sleepsTwice);
		writeTestFile(
			root,
			"packages/demo/test/clean.test.ts",
			'import { test } from "bun:test";\ntest("ok", () => {});\n'
		);

		expect(collectFixedWaitCounts(root)).toEqual({
			"packages/demo/test/chat.test.ts": 2,
		});
	});

	test("holds on this repository", () => {
		const report = evaluateFixedWaits(
			repoRoot,
			loadFixedWaitBaseline(repoRoot)
		);

		expect(report.findings).toEqual([]);
	});
});

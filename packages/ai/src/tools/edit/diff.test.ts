import { describe, expect, test } from "bun:test";
import { buildEditDiff, isRenderableEditDiff } from "./diff";

describe("buildEditDiff", () => {
	test("builds eight lines of context around a change", () => {
		const before = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		const after = before.replace("line 7", "changed 7");
		const result = buildEditDiff(before, after, "src/example.ts");

		expect(result).toMatchObject({
			additions: 1,
			deletions: 1,
			omittedHunks: 0,
			truncated: false,
		});
		expect(result.patch).toContain(" line 1\n");
		expect(result.patch).toContain(" line 12\n");
		expect(result.patch).toContain("-line 7\n+changed 7\n");
	});
	test("normalizes CRLF and removes common indentation from the patch", () => {
		const result = buildEditDiff(
			"  one\r\n  two\r\n",
			"  one\r\n  three\r\n",
			"src/example.ts"
		);

		expect(result.patch).toContain("-two\n+three");
		expect(result.patch).not.toContain("\r");
	});

	test("returns zero stats and no patch for a no-op", () => {
		expect(buildEditDiff("same\n", "same\r\n", "src/example.ts")).toEqual({
			additions: 0,
			deletions: 0,
			omittedHunks: 0,
			patch: "",
			truncated: false,
		});
	});
	test("keeps complete hunks and full stats when the patch exceeds limits", () => {
		const beforeLines = Array.from(
			{ length: 3000 },
			(_, index) => `line ${index}`
		);
		const afterLines = beforeLines.map((line, index) =>
			index % 7 === 0 ? `changed ${index}` : line
		);
		const result = buildEditDiff(
			`${beforeLines.join("\n")}\n`,
			`${afterLines.join("\n")}\n`,
			"src/example.ts"
		);

		expect(result.truncated).toBe(true);
		expect(result.omittedHunks).toBeGreaterThan(0);
		expect(result.additions).toBeGreaterThan(0);
		expect(result.deletions).toBe(result.additions);
		expect(isRenderableEditDiff(result)).toBe(true);
	});

	test("falls back to stats when one hunk cannot fit", () => {
		const result = buildEditDiff(
			`${"a".repeat(300_000)}\n`,
			`${"b".repeat(300_000)}\n`,
			"src/example.ts"
		);

		expect(result).toEqual({
			additions: 1,
			deletions: 1,
			omittedHunks: 1,
			patch: "",
			truncated: true,
		});
	});
	test("counts changes whose content starts with diff header characters", () => {
		const result = buildEditDiff("--old\n", "++new\n", "src/example.ts");

		expect(result.additions).toBe(1);
		expect(result.deletions).toBe(1);
	});
});

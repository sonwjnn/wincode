import { describe, expect, test } from "bun:test";
import type { GrepSearchInput } from "./backend";
import { buildRipgrepArguments } from "./ripgrep";

const input: GrepSearchInput = {
	cwd: "/workspace",
	ignoredDirectoryNames: [".git", "node_modules"],
	maxDepth: 5,
	maxFileBytes: 1_000_000,
	maxFiles: 1000,
	maxLineBytes: 1000,
	maxMatches: 1000,
	path: "src",
	pattern: "--looks-like-an-option",
};

describe("ripgrep adapter", () => {
	test("keeps search arguments after the option terminator", () => {
		const args = buildRipgrepArguments(input);
		const separator = args.indexOf("--");

		expect(separator).toBeGreaterThan(-1);
		expect(args.slice(separator)).toEqual([
			"--",
			"--looks-like-an-option",
			"src",
		]);
		expect(args).toContain("--no-config");
		expect(args).toContain("--json");
		expect(args).toContain("--line-number");
	});

	test("excludes Wincode ignored directories while including hidden files", () => {
		const args = buildRipgrepArguments(input);

		expect(args).toContain("--hidden");
		expect(args).toContain("--glob");
		expect(args).toContain("!**/.git/**");
		expect(args).toContain("!**/node_modules/**");
	});
});

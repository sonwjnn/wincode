import { describe, expect, test } from "bun:test";
import { filterFileMentionOptions } from "./file-mention-options";

describe("file mention options", () => {
	test("filters by path substring", () => {
		expect(
			filterFileMentionOptions(
				[
					{ label: "packages/foo/", path: "packages/foo", type: "directory" },
					{
						label: "apps/cli/src/index.ts",
						path: "apps/cli/src/index.ts",
						type: "file",
					},
				],
				"cli"
			)
		).toEqual([
			{
				label: "apps/cli/src/index.ts",
				path: "apps/cli/src/index.ts",
				type: "file",
			},
		]);
	});

	test("returns all items for empty query", () => {
		expect(filterFileMentionOptions([], "")).toEqual([]);
	});

	test("limits result count", () => {
		const options = Array.from({ length: 101 }, (_, index) => ({
			label: `file-${index}.ts`,
			path: `file-${index}.ts`,
			type: "file" as const,
		}));

		expect(filterFileMentionOptions(options, "")).toHaveLength(100);
		expect(filterFileMentionOptions(options, "file")).toHaveLength(100);
	});
	test("ranks basename matches ahead of parent-directory matches", () => {
		const options = [
			{
				label: "bot-message/renderer.ts",
				path: "bot-message/renderer.ts",
				type: "file" as const,
			},
			{
				label: "src/prebot-message.ts",
				path: "src/prebot-message.ts",
				type: "file" as const,
			},
			{
				label: "src/bot-message-helper.ts",
				path: "src/bot-message-helper.ts",
				type: "file" as const,
			},
			{
				label: "apps/cli/src/bot-message.tsx",
				path: "apps/cli/src/bot-message.tsx",
				type: "file" as const,
			},
		];

		expect(
			filterFileMentionOptions(options, "bot-message").map(
				(option) => option.path
			)
		).toEqual([
			"apps/cli/src/bot-message.tsx",
			"src/bot-message-helper.ts",
			"src/prebot-message.ts",
			"bot-message/renderer.ts",
		]);
	});

	test("matches extensionless stems and subsequence abbreviations", () => {
		const botMessageOption = {
			label: "apps/cli/src/bot-message.tsx",
			path: "apps/cli/src/bot-message.tsx",
			type: "file" as const,
		};
		const options = [
			botMessageOption,
			{
				label: "apps/cli/src/other.ts",
				path: "apps/cli/src/other.ts",
				type: "file" as const,
			},
		];

		expect(filterFileMentionOptions(options, "botmsg")).toEqual([
			botMessageOption,
		]);
		expect(filterFileMentionOptions(options, "bot-message")).toEqual([
			botMessageOption,
		]);
	});

	test("keeps slash-containing queries in path context", () => {
		const options = [
			{
				label: "apps/cli/",
				path: "apps/cli",
				type: "directory" as const,
			},
			{
				label: "apps/cli/src/",
				path: "apps/cli/src",
				type: "directory" as const,
			},
			{
				label: "apps/cli/src/index.ts",
				path: "apps/cli/src/index.ts",
				type: "file" as const,
			},
			{
				label: "apps/cli.ts",
				path: "apps/cli.ts",
				type: "file" as const,
			},
			{
				label: "apps/web/src/index.ts",
				path: "apps/web/src/index.ts",
				type: "file" as const,
			},
			{
				label: "packages/cli/src/index.ts",
				path: "packages/cli/src/index.ts",
				type: "file" as const,
			},
		];

		expect(
			filterFileMentionOptions(options, "apps/cli/").map(
				(option) => option.path
			)
		).toEqual(["apps/cli/src", "apps/cli/src/index.ts"]);

		expect(
			filterFileMentionOptions(options, "apps/cli").map(
				(option) => option.path
			)[0]
		).toBe("apps/cli");

		expect(
			filterFileMentionOptions(options, "apps/cli//").map(
				(option) => option.path
			)
		).toEqual(["apps/cli/src", "apps/cli/src/index.ts"]);

		expect(
			filterFileMentionOptions(options, "cli/").map((option) => option.path)
		).toEqual([
			"apps/cli/src",
			"apps/cli/src/index.ts",
			"packages/cli/src/index.ts",
		]);
	});

	test("orders equal-quality matches by canonical path", () => {
		const options = [
			{
				label: "z/foo.ts",
				path: "z/foo.ts",
				type: "file" as const,
			},
			{
				label: "a/foo.ts",
				path: "a/foo.ts",
				type: "file" as const,
			},
		];

		expect(
			filterFileMentionOptions(options, "foo").map((option) => option.path)
		).toEqual(["a/foo.ts", "z/foo.ts"]);
	});

	test("applies the result limit after ranking", () => {
		const options = [
			...Array.from({ length: 100 }, (_, index) => ({
				label: `noise/target-${index}.ts`,
				path: `noise/target-${index}.ts`,
				type: "file" as const,
			})),
			{
				label: "deep/target.ts",
				path: "deep/target.ts",
				type: "file" as const,
			},
		];

		const matches = filterFileMentionOptions(options, "target");

		expect(matches).toHaveLength(100);
		expect(matches[0]?.path).toBe("deep/target.ts");
	});
	test("scopes trailing-slash queries to recursive descendants", () => {
		const options = [
			{
				label: "src/",
				path: "src",
				type: "directory" as const,
			},
			{
				label: "src/components/",
				path: "src/components",
				type: "directory" as const,
			},
			{
				label: "src/components/button.tsx",
				path: "src/components/button.tsx",
				type: "file" as const,
			},
		];

		expect(
			filterFileMentionOptions(options, "src/").map((option) => option.path)
		).toEqual(["src/components", "src/components/button.tsx"]);
	});
});

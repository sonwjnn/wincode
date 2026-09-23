import { describe, expect, test } from "bun:test";
import { filterFileMentionOptions } from "@/modules/file-mentions/utils/file-mention-options";

describe("file mention options", () => {
	test("filters by path substring", () => {
		expect(
			filterFileMentionOptions(
				[
					{ label: "packages/foo/", path: "packages/foo", type: "directory" },
					{
						label: "packages/coding-agent/tui/index.ts",
						path: "packages/coding-agent/tui/index.ts",
						type: "file",
					},
				],
				"coding-agent"
			)
		).toEqual([
			{
				label: "packages/coding-agent/tui/index.ts",
				path: "packages/coding-agent/tui/index.ts",
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
				label: "packages/coding-agent/modules/src/bot-message.tsx",
				path: "packages/coding-agent/modules/src/bot-message.tsx",
				type: "file" as const,
			},
		];

		expect(
			filterFileMentionOptions(options, "bot-message").map(
				(option) => option.path
			)
		).toEqual([
			"packages/coding-agent/modules/src/bot-message.tsx",
			"src/bot-message-helper.ts",
			"src/prebot-message.ts",
			"bot-message/renderer.ts",
		]);
	});

	test("matches extensionless stems and subsequence abbreviations", () => {
		const botMessageOption = {
			label: "packages/coding-agent/modules/src/bot-message.tsx",
			path: "packages/coding-agent/modules/src/bot-message.tsx",
			type: "file" as const,
		};
		const options = [
			botMessageOption,
			{
				label: "packages/coding-agent/modules/src/other.ts",
				path: "packages/coding-agent/modules/src/other.ts",
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
				label: "packages/coding-agent/modules/",
				path: "packages/coding-agent/modules",
				type: "directory" as const,
			},
			{
				label: "packages/coding-agent/modules/src/",
				path: "packages/coding-agent/modules/src",
				type: "directory" as const,
			},
			{
				label: "packages/coding-agent/modules/src/index.ts",
				path: "packages/coding-agent/modules/src/index.ts",
				type: "file" as const,
			},
			{
				label: "packages/coding-agent.ts",
				path: "packages/coding-agent.ts",
				type: "file" as const,
			},
			{
				label: "apps/web/src/index.ts",
				path: "apps/web/src/index.ts",
				type: "file" as const,
			},
			{
				label: "packages/coding-agent/tui/index.ts",
				path: "packages/coding-agent/tui/index.ts",
				type: "file" as const,
			},
		];

		expect(
			filterFileMentionOptions(options, "packages/coding-agent/modules/").map(
				(option) => option.path
			)
		).toEqual([
			"packages/coding-agent/modules/src",
			"packages/coding-agent/modules/src/index.ts",
		]);

		expect(
			filterFileMentionOptions(options, "packages/coding-agent/modules").map(
				(option) => option.path
			)[0]
		).toBe("packages/coding-agent/modules");

		expect(
			filterFileMentionOptions(options, "packages/coding-agent/modules//").map(
				(option) => option.path
			)
		).toEqual([
			"packages/coding-agent/modules/src",
			"packages/coding-agent/modules/src/index.ts",
		]);

		expect(
			filterFileMentionOptions(options, "tui/").map((option) => option.path)
		).toEqual(["packages/coding-agent/tui/index.ts"]);
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

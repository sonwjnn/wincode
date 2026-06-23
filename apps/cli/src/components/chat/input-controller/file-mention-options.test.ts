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
});

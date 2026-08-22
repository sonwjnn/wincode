import { describe, expect, test } from "bun:test";
import { editInputSchema, editOutputSchema } from "./schema";

describe("editInputSchema", () => {
	test("rejects replacements that cannot change the file", () => {
		expect(
			editInputSchema.safeParse({
				find: "unchanged",
				path: "README.md",
				replace: "unchanged",
			})
		).toMatchObject({ success: false });
	});
});

describe("editOutputSchema", () => {
	test("accepts legacy outputs without display metadata", () => {
		expect(
			editOutputSchema.safeParse({ path: "src/example.ts", replacements: 1 })
		).toMatchObject({ success: true });
	});

	test("accepts persisted diff display metadata", () => {
		expect(
			editOutputSchema.safeParse({
				editDiff: {
					additions: 1,
					deletions: 1,
					omittedHunks: 0,
					patch: "Index: src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
					truncated: false,
				},
				path: "src/example.ts",
				replacements: 1,
			})
		).toMatchObject({ success: true });
	});
});

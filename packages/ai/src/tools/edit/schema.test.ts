import { describe, expect, test } from "bun:test";
import { codingServerTools } from "../../server/tools";
import { editInputSchema, editOutputSchema } from "./schema";

describe("editInputSchema", () => {
	test("requires an edit body in the model-facing JSON schema", async () => {
		const { inputSchema } = codingServerTools.edit;
		if (!("jsonSchema" in inputSchema)) {
			throw new Error("Edit server tool must expose its model JSON schema");
		}
		const jsonSchema = await inputSchema.jsonSchema;

		expect(jsonSchema).toMatchObject({
			oneOf: [
				{ required: ["content", "path"] },
				{ required: ["find", "path", "replace"] },
			],
		});
	});

	test("rejects replacements that cannot change the file", () => {
		expect(
			editInputSchema.safeParse({
				find: "unchanged",
				path: "README.md",
				replace: "unchanged",
			})
		).toMatchObject({ success: false });
	});

	test("accepts full-file content without duplicating the original text", () => {
		expect(
			editInputSchema.safeParse({
				content: "replacement content",
				path: "README.md",
			})
		).toMatchObject({ success: true });
	});

	test.each([
		{ path: "README.md" },
		{
			content: "whole file",
			find: "old",
			path: "README.md",
			replace: "new",
		},
		{ find: "old", path: "README.md" },
	])("rejects missing or mixed edit modes", (input) => {
		expect(editInputSchema.safeParse(input)).toMatchObject({ success: false });
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

import { describe, expect, test } from "bun:test";
import { toolSchemas } from ".";

describe("toolSchemas", () => {
	test("exports schema-only definitions for coding tools", () => {
		const names = toolSchemas.map((toolSchema) => toolSchema.name);

		expect(names).toEqual(["list", "grep", "read", "write", "edit", "bash"]);
		for (const toolSchema of toolSchemas) {
			expect(toolSchema.description.length).toBeGreaterThan(0);
			expect(toolSchema.schema).toBeDefined();
			expect("runtime" in toolSchema).toBe(false);
			expect("execute" in toolSchema).toBe(false);
		}
	});

	test("validates write input with parent directories", () => {
		const writeTool = toolSchemas.find(
			(toolSchema) => toolSchema.name === "write"
		);

		expect(
			writeTool?.schema.parse({
				content: "hello",
				path: "nested/file.txt",
			})
		).toEqual({ content: "hello", path: "nested/file.txt" });
	});
});

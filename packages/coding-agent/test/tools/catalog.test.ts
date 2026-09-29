import { expect, test } from "bun:test";
import { z } from "zod";
import { codingToolDefinitionFor } from "@/modules/tools/catalog";
import { readInputSchema } from "@/modules/tools/read/schema";

test("guides the model to omit File Versions on each file's first Read", () => {
	const read = codingToolDefinitionFor("read", "posix");

	expect(read.description).toContain("For the first read of each file");
	expect(read.description).toContain("omit expectedVersion");
	expect(read.description.toLowerCase()).toContain(
		"never guess a file version"
	);
	expect(readInputSchema.shape.expectedVersion.description).toContain(
		"first read of each file"
	);
});
test("Write exposes an explicit no-version case to model tool callers", () => {
	const write = codingToolDefinitionFor("write", "posix");
	if (!("safeParse" in write.inputSchema)) {
		throw new Error("Expected a Zod schema for Write input.");
	}
	const schema = z.toJSONSchema(write.inputSchema);
	expect(schema.required).toContain("expectedVersion");
	expect(schema.properties?.expectedVersion).toMatchObject({
		anyOf: [{ pattern: "^[0-9a-f]{32}$", type: "string" }, { type: "null" }],
	});
});

test("shell definitions give the model platform-correct command syntax", () => {
	const posix = codingToolDefinitionFor("shell", "posix");
	const windows = codingToolDefinitionFor("shell", "win32");

	expect(posix.description).toContain("/bin/bash -c");
	expect(posix.description).toContain("bash syntax");
	expect(windows.description).toContain("powershell.exe -Command");
	expect(windows.description).toContain("Windows PowerShell syntax");
});

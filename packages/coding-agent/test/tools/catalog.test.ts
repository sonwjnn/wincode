import { expect, test } from "bun:test";
import { codingToolDefinitionFor } from "@/modules/tools/catalog";

test("shell definitions give the model platform-correct command syntax", () => {
	const posix = codingToolDefinitionFor("shell", "posix");
	const windows = codingToolDefinitionFor("shell", "win32");

	expect(posix.description).toContain("/bin/bash -c");
	expect(posix.description).toContain("bash syntax");
	expect(windows.description).toContain("powershell.exe -Command");
	expect(windows.description).toContain("Windows PowerShell syntax");
});

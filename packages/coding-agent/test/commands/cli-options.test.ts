import { describe, expect, test } from "bun:test";
import { parseCliOptions } from "@/shared/cli-options";

describe("parseCliOptions", () => {
	test("disables each bundled optional Plugin independently", () => {
		expect(
			parseCliOptions([
				"node",
				"cli",
				"--no-plugin",
				"mcp",
				"--no-plugin",
				"subagents",
			]).disabledPlugins
		).toEqual(["mcp", "subagents"]);
	});
});

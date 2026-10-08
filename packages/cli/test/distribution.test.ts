import { expect, test } from "bun:test";

test("Wincode CLI installation resolves its default Plugin entry points", () => {
	expect(import.meta.resolve("@wincode/coding-agent/cli")).toBeString();
	expect(import.meta.resolve("@wincode/mcp/plugin")).toBeString();
	expect(import.meta.resolve("@wincode/subagents/plugin")).toBeString();
});

import { describe, expect, test } from "bun:test";
import { isJsonValue } from "@/modules/mcp";

const nestedValue = (depth: number): unknown => {
	let value: unknown = "leaf";
	for (let index = 0; index < depth; index += 1) {
		value = { child: value };
	}
	return value;
};

describe("MCP JSON manifest policy", () => {
	test("rejects values beyond the MCP nesting limit", () => {
		expect(isJsonValue(nestedValue(64))).toBe(true);
		expect(isJsonValue(nestedValue(65))).toBe(false);
	});
});

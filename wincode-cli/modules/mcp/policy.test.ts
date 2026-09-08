import { describe, expect, test } from "bun:test";
import { mcpExecutionPolicySchema } from "./policy";

describe("MCP policy", () => {
	test("accepts supported policies", () => {
		for (const policy of ["allow", "ask", "deny"] as const) {
			expect(mcpExecutionPolicySchema.parse(policy)).toBe(policy);
		}
	});

	test("rejects unsupported policies", () => {
		expect(mcpExecutionPolicySchema.safeParse("always").success).toBe(false);
	});
});

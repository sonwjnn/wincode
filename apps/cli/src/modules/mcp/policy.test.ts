import { describe, expect, test } from "bun:test";
import { getMcpPolicyDecision, loadMcpPolicy } from "./policy";

const fs = (value: string) => ({ readFile: async () => value });
describe("MCP policy", () => {
	test("loads exact policy and defaults to ask", async () => {
		const result = await loadMcpPolicy({
			workspace: "/p",
			fs: fs('{"servers":{"a":"allow"}}'),
		});
		expect(getMcpPolicyDecision(result.policy, "a")).toBe("allow");
		expect(getMcpPolicyDecision(result.policy, "b")).toBe("ask");
	});
	test("missing and malformed files do not create config", async () => {
		const missing = await loadMcpPolicy({
			workspace: "/p",
			fs: {
				readFile: async () => {
					throw new Error("missing");
				},
			},
		});
		expect(missing.policy).toEqual({ servers: {} });
		const malformed = await loadMcpPolicy({ workspace: "/p", fs: fs("[]") });
		expect(malformed.diagnostics[0]?.code).toBe("malformed");
	});
});

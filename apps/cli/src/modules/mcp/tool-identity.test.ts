import { describe, expect, test } from "bun:test";
import { mcpToolIdentity } from "./tool-identity";

const IDENTITY_PATTERN = /^mcp_[A-Za-z0-9_-]+$/;

describe("MCP tool identity", () => {
	test("is stable, bounded, sanitized, and distinct", async () => {
		const one = await mcpToolIdentity("weird server/é", "tool!name");
		expect(one).toMatch(IDENTITY_PATTERN);
		expect(one.length).toBeLessThanOrEqual(64);
		expect(one).toBe(await mcpToolIdentity("weird server/é", "tool!name"));
		expect(one).not.toBe(await mcpToolIdentity("weird server/é", "tool?name"));
	});
});

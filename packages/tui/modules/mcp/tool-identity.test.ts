import { describe, expect, test } from "bun:test";
import { qualifyMcpToolName } from "./tool-identity";

const IDENTITY_PATTERN = /^mcp_[A-Za-z0-9_-]+$/;
const IDENTITY_WITH_HASH_PATTERN =
	/^mcp_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+_[0-9a-f]{8}$/;

describe("MCP tool identity", () => {
	test("is stable, bounded, sanitized, and distinct", async () => {
		const one = await qualifyMcpToolName("weird server/é", "tool!name");
		expect(one).toMatch(IDENTITY_PATTERN);
		expect(one.length).toBeLessThanOrEqual(64);
		expect(one).toBe(await qualifyMcpToolName("weird server/é", "tool!name"));
		expect(one).not.toBe(
			await qualifyMcpToolName("weird server/é", "tool?name")
		);
	});

	test("bounds long identities and preserves hash suffix", async () => {
		const identity = await qualifyMcpToolName(
			"server-".repeat(100),
			"tool-".repeat(100)
		);
		expect(identity.length).toBeLessThanOrEqual(64);
		expect(identity).toMatch(IDENTITY_WITH_HASH_PATTERN);
	});
});

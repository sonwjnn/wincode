import { describe, expect, it } from "bun:test";
import {
	getSafePositiveMaxSteps,
	invokeCodingAgentLifecycleCallback,
	prepareCodingAgentCall,
} from "./agent";

describe("invokeCodingAgentLifecycleCallback", () => {
	it("swallows callback errors", async () => {
		let called = false;

		await invokeCodingAgentLifecycleCallback(async () => {
			called = true;
			throw new Error("boom");
		}, undefined);

		expect(called).toBe(true);
	});

	it("runs callback once", async () => {
		let count = 0;

		await invokeCodingAgentLifecycleCallback(() => {
			count += 1;
		}, undefined);

		expect(count).toBe(1);
	});

	it("clamps max steps to safe positive value", () => {
		expect(getSafePositiveMaxSteps(undefined)).toBe(1);
		expect(getSafePositiveMaxSteps(0)).toBe(1);
		expect(getSafePositiveMaxSteps(3)).toBe(3);
	});
});

describe("prepareCodingAgentCall", () => {
	const manifest = [
		{
			name: "mcp_search_docs",
			description: "Search docs",
			inputSchema: { type: "object" },
		},
	];

	it("merges MCP tools into Build activeTools and tools", () => {
		const prepared = prepareCodingAgentCall({
			options: { mode: "build", mcpTools: manifest },
			messages: [],
		});

		expect(prepared.activeTools).toContain("mcp_search_docs");
		expect(prepared.tools).toHaveProperty("mcp_search_docs");
	});

	it("keeps read-only built-ins active and excludes MCP in Plan", () => {
		const prepared = prepareCodingAgentCall({
			options: { mode: "plan", mcpTools: manifest },
		});

		expect(prepared.activeTools).toEqual(["read", "list", "grep"]);
		expect(prepared.tools).toHaveProperty("mcp_search_docs");
	});

	it("does not let MCP names replace built-ins in either mode", () => {
		const collisionManifest = [
			{
				name: "mcp_read",
				description: "Search docs",
				inputSchema: { type: "object" },
			},
		];
		for (const mode of ["build", "plan"] as const) {
			const prepared = prepareCodingAgentCall({
				options: { mode, mcpTools: collisionManifest },
			});
			expect(prepared.tools.read?.type).not.toBe("dynamic");
		}
	});
});

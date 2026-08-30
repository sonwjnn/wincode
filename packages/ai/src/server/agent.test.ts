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
	const buildAgent = {
		instructions: "Implement changes with read and write access.",
		visibleCodingTools: ["read", "write", "edit", "list", "glob", "grep"],
	} as const;

	it("merges MCP tools into Agent activeTools and tools", () => {
		const prepared = prepareCodingAgentCall({
			options: { mcpTools: manifest, resolvedAgent: buildAgent },
			messages: [],
		});

		expect(prepared.activeTools).toEqual([
			"read",
			"write",
			"edit",
			"list",
			"glob",
			"grep",
			"mcp_search_docs",
		]);
		expect(prepared.tools).toHaveProperty("mcp_search_docs");
	});

	it("activates only the resolved Agent's coding tools", () => {
		const prepared = prepareCodingAgentCall({
			options: {
				resolvedAgent: {
					instructions: "Read-only analysis.",
					visibleCodingTools: ["read", "list", "glob", "grep"],
				},
			},
		});

		expect(prepared.activeTools).toEqual(["read", "list", "glob", "grep"]);
	});

	it("does not let MCP names replace built-ins", () => {
		const collisionManifest = [
			{
				name: "mcp_read",
				description: "Search docs",
				inputSchema: { type: "object" },
			},
		];
		const prepared = prepareCodingAgentCall({
			options: {
				mcpTools: collisionManifest,
				resolvedAgent: {
					instructions: "Implement changes.",
					visibleCodingTools: ["read", "write"],
				},
			},
		});
		expect(prepared.tools.read?.type).not.toBe("dynamic");
	});

	it("composes Agent instructions over the immutable base", () => {
		const prepared = prepareCodingAgentCall({
			options: {
				resolvedAgent: {
					instructions: "Review code without editing it.",
					visibleCodingTools: ["read", "grep"],
				},
				mcpTools: manifest,
			},
		});

		expect(prepared.activeTools).toEqual(["read", "grep", "mcp_search_docs"]);
		expect(prepared.instructions).toContain(
			"You are a basic coding agent running in a user's CLI."
		);
		expect(prepared.instructions).toContain("Review code without editing it.");
	});

	it("replaces constructor instructions with resolved Agent instructions", () => {
		const prepared = prepareCodingAgentCall({
			instructions: "Default Build instructions",
			options: {
				resolvedAgent: {
					instructions: "Resolved Agent instructions",
					visibleCodingTools: ["read"],
				},
			},
		});

		expect(prepared.instructions).not.toContain("Default Build instructions");
		expect(prepared.instructions).toContain("Resolved Agent instructions");
	});

	it("fails closed without a resolved Agent", () => {
		expect(() => prepareCodingAgentCall({ options: {}, messages: [] })).toThrow(
			"Missing resolved Agent for coding agent call"
		);
	});
});

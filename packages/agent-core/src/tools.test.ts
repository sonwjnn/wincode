import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	AgentInvariantError,
	createToolRegistry,
	isResolvedTool,
	isToolCallOutput,
	isToolDefinition,
	type ResolvedTool,
	type ToolDefinition,
} from "./index";

const readDefinition = {
	description: "Read a UTF-8 text file.",
	inputSchema: z.object({ path: z.string() }),
	name: "read",
	outputSchema: z.object({ content: z.string(), path: z.string() }),
} satisfies ToolDefinition;

const globDefinition = {
	description: "Find workspace files by glob pattern.",
	inputSchema: z.object({ pattern: z.string() }),
	name: "glob",
} satisfies ToolDefinition;

describe("Tool Definition contract", () => {
	test("accepts a definition with input and output schemas", () => {
		expect(isToolDefinition(readDefinition)).toBe(true);
	});

	test("rejects definitions with malformed shapes", () => {
		expect(isToolDefinition(null)).toBe(false);
		expect(isToolDefinition({ name: "read" })).toBe(false);
		expect(isToolDefinition({ ...readDefinition, name: "" })).toBe(false);
		expect(isToolDefinition({ ...readDefinition, description: 5 })).toBe(false);
		expect(
			isToolDefinition({ ...readDefinition, inputSchema: { not: "zod" } })
		).toBe(false);
		expect(
			isToolDefinition({ ...readDefinition, outputSchema: undefined })
		).toBe(true);
	});
});

describe("Tool Call Output contract", () => {
	test("accepts success and failure outputs", () => {
		expect(
			isToolCallOutput({ output: { content: "x" }, type: "success" })
		).toBe(true);
		expect(
			isToolCallOutput({ errorText: "Read denied by policy", type: "failure" })
		).toBe(true);
	});

	test("rejects malformed outputs", () => {
		expect(isToolCallOutput(undefined)).toBe(false);
		expect(isToolCallOutput({ type: "success" })).toBe(false);
		expect(isToolCallOutput({ type: "failure" })).toBe(false);
		expect(isToolCallOutput({ errorText: "", type: "failure" })).toBe(false);
		expect(isToolCallOutput({ errorText: "x", type: "deny" })).toBe(false);
	});
});

describe("Resolved Tool contract", () => {
	const execute = async () => ({
		output: { content: "x" },
		type: "success" as const,
	});

	test("accepts a definition composed with a gated executor", () => {
		const tool = { definition: readDefinition, execute } satisfies ResolvedTool;
		expect(isResolvedTool(tool)).toBe(true);
	});

	test("rejects a definition without an executor", () => {
		expect(isResolvedTool({ definition: readDefinition })).toBe(false);
		expect(isResolvedTool({ execute })).toBe(false);
	});
});

describe("Tool Registry", () => {
	test("registers definitions for lookup by name", () => {
		const registry = createToolRegistry([readDefinition, globDefinition]);

		expect(registry.definitions).toHaveLength(2);
		expect(registry.has("read")).toBe(true);
		expect(registry.has("grep")).toBe(false);
		expect(registry.get("read")).toBe(readDefinition);
		expect(registry.get("unknown")).toBeUndefined();
	});

	test("require returns the definition or throws an invariant violation", () => {
		const registry = createToolRegistry([readDefinition]);
		expect(registry.require("read")).toBe(readDefinition);
		expect(() => registry.require("write")).toThrow(AgentInvariantError);
		try {
			registry.require("write");
		} catch (error) {
			expect(error).toBeInstanceOf(AgentInvariantError);
			expect((error as AgentInvariantError).cause).toBe("write");
		}
	});

	test("rejects duplicate tool names as an invariant violation", () => {
		expect(() =>
			createToolRegistry([readDefinition, { ...readDefinition }])
		).toThrow(AgentInvariantError);
	});
});

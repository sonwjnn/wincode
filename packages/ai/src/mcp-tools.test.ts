import { describe, expect, it } from "bun:test";
import {
	MAX_MCP_RESULT_BYTES,
	MAX_MCP_TOOL_COUNT,
	MAX_MCP_TOOL_DESCRIPTION_BYTES,
	MAX_MCP_TOOL_NAME_LENGTH,
	MAX_MCP_TOOL_SCHEMA_BYTES,
	mcpToolManifestEntrySchema,
	mcpToolManifestSchema,
} from "./mcp-tools";

const validTool = {
	name: "read_file",
	description: "Read a file.",
	inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

describe("MCP tool wire contracts", () => {
	it("accepts valid tools and manifests", () => {
		expect(mcpToolManifestEntrySchema.parse(validTool)).toEqual(validTool);
		expect(mcpToolManifestSchema.parse([validTool])).toEqual([validTool]);
	});

	it("bounds tool count", () => {
		expect(() =>
			mcpToolManifestSchema.parse(
				Array.from({ length: MAX_MCP_TOOL_COUNT + 1 }, (_, index) => ({
					...validTool,
					name: `tool_${index}`,
				}))
			)
		).toThrow();
	});

	it("enforces exact and over UTF-8 byte boundaries", () => {
		expect(
			mcpToolManifestEntrySchema.parse({
				...validTool,
				description: "é".repeat(MAX_MCP_TOOL_DESCRIPTION_BYTES / 2),
			}).description
		).toHaveLength(MAX_MCP_TOOL_DESCRIPTION_BYTES / 2);
		expect(() =>
			mcpToolManifestEntrySchema.parse({
				...validTool,
				description: `${"é".repeat(MAX_MCP_TOOL_DESCRIPTION_BYTES / 2)}é`,
			})
		).toThrow("description exceeds");
		const schemaOverhead = JSON.stringify({ value: "" }).length;
		const exactSchema = {
			value: "x".repeat(MAX_MCP_TOOL_SCHEMA_BYTES - schemaOverhead),
		};
		expect(
			mcpToolManifestEntrySchema.parse({
				...validTool,
				inputSchema: exactSchema,
			}).inputSchema
		).toBe(exactSchema);
		expect(() =>
			mcpToolManifestEntrySchema.parse({
				...validTool,
				inputSchema: { value: `${exactSchema.value}x` },
			})
		).toThrow("inputSchema exceeds");
	});

	it("bounds full manifest using individually valid entries", () => {
		const tools = Array.from({ length: MAX_MCP_TOOL_COUNT }, (_, index) => ({
			...validTool,
			name: `tool_${index}`,
			description: "d".repeat(2048),
		}));
		expect(() => mcpToolManifestSchema.parse(tools)).toThrow(
			"manifest exceeds"
		);
	});

	it("rejects duplicate names and invalid names", () => {
		expect(() => mcpToolManifestSchema.parse([validTool, validTool])).toThrow(
			"duplicate tool name"
		);
		expect(() =>
			mcpToolManifestEntrySchema.parse({ ...validTool, name: "bad name" })
		).toThrow();
		expect(() =>
			mcpToolManifestEntrySchema.parse({
				...validTool,
				name: "a".repeat(MAX_MCP_TOOL_NAME_LENGTH + 1),
			})
		).toThrow();
	});

	it("rejects non-JSON input values", () => {
		expect(() =>
			mcpToolManifestEntrySchema.parse({
				...validTool,
				inputSchema: { value: undefined },
			})
		).toThrow();
		expect(() =>
			mcpToolManifestEntrySchema.parse({
				...validTool,
				inputSchema: { value: BigInt(1) },
			})
		).toThrow();
	});

	it("preserves own __proto__ keys", () => {
		const inputSchema = JSON.parse('{"__proto__":{"value":true}}');
		const parsed = mcpToolManifestEntrySchema.parse({
			...validTool,
			inputSchema,
		});
		expect(
			typeof parsed.inputSchema === "object" &&
				parsed.inputSchema !== null &&
				Object.hasOwn(parsed.inputSchema, "__proto__")
		).toBe(true);
		expect(parsed.inputSchema).toBe(inputSchema);
	});

	it("rejects deeply nested values without overflowing the stack", () => {
		let inputSchema: unknown = "x";
		for (let index = 0; index < 65; index += 1) {
			inputSchema = { value: inputSchema };
		}
		expect(() =>
			mcpToolManifestEntrySchema.parse({ ...validTool, inputSchema })
		).toThrow("inputSchema must contain only JSON values");
	});

	it("exports result byte bound", () => {
		expect(MAX_MCP_RESULT_BYTES).toBe(256 * 1024);
	});
});

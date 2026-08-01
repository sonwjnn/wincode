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

	it("bounds description and schema UTF-8 bytes", () => {
		expect(() =>
			mcpToolManifestEntrySchema.parse({
				...validTool,
				description: "é".repeat(MAX_MCP_TOOL_DESCRIPTION_BYTES),
			})
		).toThrow("description exceeds");
		expect(() =>
			mcpToolManifestEntrySchema.parse({
				...validTool,
				inputSchema: { value: "x".repeat(MAX_MCP_TOOL_SCHEMA_BYTES) },
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

	it("exports result byte bound", () => {
		expect(MAX_MCP_RESULT_BYTES).toBe(256 * 1024);
	});
});

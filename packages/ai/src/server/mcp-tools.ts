import { jsonSchema, type ToolSet } from "ai";
import type { McpToolManifest } from "../mcp-tools";

type DynamicMcpTool = ToolSet[string] & { type: "dynamic" };

export const convertMcpToolManifest = (manifest: McpToolManifest): ToolSet =>
	Object.fromEntries(
		manifest.map((entry) => [
			entry.name,
			{
				type: "dynamic",
				description: entry.description,
				inputSchema: jsonSchema(entry.inputSchema),
			} satisfies DynamicMcpTool,
		])
	);

export const createMcpServerTools = convertMcpToolManifest;

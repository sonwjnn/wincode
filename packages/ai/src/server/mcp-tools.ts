import { jsonSchema, type Tool } from "ai";
import type { McpToolManifest } from "../mcp-tools";

export type DynamicMcpTool = Tool<unknown, never> & { type: "dynamic" };

export const convertMcpToolManifest = (
	manifest: McpToolManifest
): Record<string, DynamicMcpTool> => {
	const tools: Record<string, DynamicMcpTool> = {};
	for (const entry of manifest) {
		tools[entry.name] = {
			type: "dynamic",
			description: entry.description,
			inputSchema: jsonSchema(entry.inputSchema),
		};
	}
	return tools;
};

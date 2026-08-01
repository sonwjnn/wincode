import { z } from "zod";

export const MAX_MCP_TOOL_COUNT = 128;
export const MAX_MCP_TOOL_NAME_LENGTH = 64;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 8 * 1024;
export const MAX_MCP_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_MCP_MANIFEST_BYTES = 256 * 1024;
export const MAX_MCP_RESULT_BYTES = 256 * 1024;

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(jsonValueSchema),
		z.record(z.string(), jsonValueSchema),
	])
);

const byteLength = (value: string): number =>
	new TextEncoder().encode(value).byteLength;

export const mcpToolSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(MAX_MCP_TOOL_NAME_LENGTH)
			.regex(/^[A-Za-z0-9_-]+$/),
		description: z.string().superRefine((value, context) => {
			if (byteLength(value) > MAX_MCP_TOOL_DESCRIPTION_BYTES) {
				context.addIssue({
					code: "custom",
					message: "description exceeds byte limit",
				});
			}
		}),
		inputSchema: z
			.record(z.string(), jsonValueSchema)
			.superRefine((value, context) => {
				if (byteLength(JSON.stringify(value)) > MAX_MCP_TOOL_SCHEMA_BYTES) {
					context.addIssue({
						code: "custom",
						message: "inputSchema exceeds byte limit",
					});
				}
			}),
	})
	.strict();

export type McpTool = z.infer<typeof mcpToolSchema>;
export const mcpToolManifestEntrySchema = mcpToolSchema;
export type McpToolManifestEntry = McpTool;

export const mcpToolManifestSchema = z
	.array(mcpToolSchema)
	.max(MAX_MCP_TOOL_COUNT)
	.superRefine((tools, context) => {
		const names = new Set<string>();
		for (const tool of tools) {
			if (names.has(tool.name)) {
				context.addIssue({
					code: "custom",
					message: `duplicate tool name: ${tool.name}`,
				});
			}
			names.add(tool.name);
		}
		if (byteLength(JSON.stringify(tools)) > MAX_MCP_MANIFEST_BYTES) {
			context.addIssue({
				code: "custom",
				message: "manifest exceeds byte limit",
			});
		}
	});

export type McpToolManifest = z.infer<typeof mcpToolManifestSchema>;

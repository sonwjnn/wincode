import { z } from "zod";

export const MAX_MCP_TOOL_COUNT = 128;
export const MAX_MCP_TOOL_NAME_LENGTH = 64;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 8 * 1024;
export const MAX_MCP_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_MCP_MANIFEST_BYTES = 256 * 1024;
export const MAX_MCP_RESULT_BYTES = 256 * 1024;
export const MCP_TOOL_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export type JsonValue =
	| boolean
	| null
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

const MAX_JSON_NESTING_DEPTH = 64;

const isJsonPrimitive = (
	value: unknown
): value is null | boolean | number | string =>
	value === null ||
	typeof value === "string" ||
	typeof value === "boolean" ||
	(typeof value === "number" && Number.isFinite(value));

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: iterative traversal deliberately handles every JSON container type
const isJsonValue = (value: unknown): value is JsonValue => {
	try {
		const pending: Array<{ value: unknown; depth: number }> = [
			{ value, depth: 0 },
		];
		const visited = new WeakSet<object>();

		while (pending.length > 0) {
			const item = pending.pop();
			if (!item) {
				continue;
			}
			const { value: current, depth } = item;
			if (depth > MAX_JSON_NESTING_DEPTH) {
				return false;
			}
			if (isJsonPrimitive(current)) {
				continue;
			}
			if (typeof current !== "object") {
				return false;
			}
			if (visited.has(current)) {
				return false;
			}
			visited.add(current);

			if (Array.isArray(current)) {
				for (const child of current) {
					pending.push({ value: child, depth: depth + 1 });
				}
				continue;
			}
			const prototype = Object.getPrototypeOf(current);
			if (prototype !== Object.prototype && prototype !== null) {
				return false;
			}
			for (const child of Object.values(current)) {
				pending.push({ value: child, depth: depth + 1 });
			}
		}
		return true;
	} catch {
		return false;
	}
};

const byteLength = (value: string): number =>
	new TextEncoder().encode(value).byteLength;

export type McpToolManifestEntry = {
	name: string;
	description: string;
	inputSchema: JsonObject;
};

export const mcpToolManifestEntrySchema: z.ZodType<McpToolManifestEntry> =
	z.custom<McpToolManifestEntry>(
		(value) => {
			if (typeof value !== "object" || value === null) {
				return false;
			}
			const entry = value as Record<string, unknown>;
			if (
				Object.keys(entry).some(
					(key) => !["name", "description", "inputSchema"].includes(key)
				)
			) {
				return false;
			}
			if (
				typeof entry.name !== "string" ||
				entry.name.length < 1 ||
				entry.name.length > MAX_MCP_TOOL_NAME_LENGTH ||
				!entry.name.startsWith("mcp_") ||
				!MCP_TOOL_NAME_REGEX.test(entry.name)
			) {
				return false;
			}
			if (typeof entry.description !== "string") {
				return false;
			}
			if (byteLength(entry.description) > MAX_MCP_TOOL_DESCRIPTION_BYTES) {
				return false;
			}
			if (
				typeof entry.inputSchema !== "object" ||
				entry.inputSchema === null ||
				Array.isArray(entry.inputSchema)
			) {
				return false;
			}
			const inputSchemaPrototype = Object.getPrototypeOf(entry.inputSchema);
			if (
				inputSchemaPrototype !== Object.prototype &&
				inputSchemaPrototype !== null
			) {
				return false;
			}
			if (!isJsonValue(entry.inputSchema)) {
				return false;
			}
			try {
				if (
					byteLength(JSON.stringify(entry.inputSchema)) >
					MAX_MCP_TOOL_SCHEMA_BYTES
				) {
					return false;
				}
			} catch {
				return false;
			}
			return true;
		},
		{ message: "invalid MCP tool manifest entry" }
	);

export const mcpToolManifestSchema = z
	.array(mcpToolManifestEntrySchema)
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

import {
	isObjectLike,
	isJsonObject as isRuntimeJsonObject,
	isJsonValue as isRuntimeJsonValue,
	isString,
} from "@wincode/runtime-utils";
import type { JsonObject, JsonValue, UnknownRecord } from "type-fest";
import { z } from "zod";

export const MAX_MCP_TOOL_COUNT = 128;
export const MAX_MCP_TOOL_NAME_LENGTH = 64;
export const MAX_MCP_TOOL_DESCRIPTION_BYTES = 8 * 1024;
export const MAX_MCP_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_MCP_MANIFEST_BYTES = 256 * 1024;
export const MAX_MCP_RESULT_BYTES = 256 * 1024;
export const MCP_TOOL_NAME_REGEX = /^[A-Za-z0-9_-]+$/u;

const MAX_JSON_NESTING_DEPTH = 64;

export const isJsonValue = (value: unknown): value is JsonValue =>
	isRuntimeJsonValue(value, { maxDepth: MAX_JSON_NESTING_DEPTH });

export const isJsonObject = (value: unknown): value is JsonObject =>
	isRuntimeJsonObject(value, { maxDepth: MAX_JSON_NESTING_DEPTH });

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
			if (!isObjectLike(value)) {
				return false;
			}
			const entry = value as UnknownRecord;
			if (
				Object.keys(entry).some(
					(key) => !["name", "description", "inputSchema"].includes(key)
				)
			) {
				return false;
			}
			if (
				!isString(entry.name) ||
				entry.name.length < 1 ||
				entry.name.length > MAX_MCP_TOOL_NAME_LENGTH ||
				!entry.name.startsWith("mcp_") ||
				!MCP_TOOL_NAME_REGEX.test(entry.name)
			) {
				return false;
			}
			if (!isString(entry.description)) {
				return false;
			}
			if (byteLength(entry.description) > MAX_MCP_TOOL_DESCRIPTION_BYTES) {
				return false;
			}
			if (!isJsonObject(entry.inputSchema)) {
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

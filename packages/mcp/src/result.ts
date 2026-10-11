import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolCallOutput } from "@wincode/agent-core";
import {
	isArray,
	isBoolean,
	isNull,
	isNumber,
	isPlainObject,
	isString,
	isUndefined,
} from "@wincode/utils";
import type { JsonValue } from "type-fest";
import type { McpClientResourceContent } from "./client";
import { MAX_MCP_RESULT_BYTES } from "./manifest";
import type { McpCatalogSnapshot } from "./registry";
import { utf8ByteLength } from "./utf8-byte-length";

export type { JsonValue } from "type-fest";

export type McpNormalizedResult = {
	content: JsonValue[];
	isError: boolean;
	/**
	 * Marks a result authored by the registry itself (stale snapshot, unknown
	 * tool, registry rejection, disabled server, sanitized execution failure) so
	 * callers may surface that text verbatim. Results produced by an MCP server
	 * are untrusted tool content and carry no owner; callers must not surface
	 * their text through an error path.
	 */
	owner?: "registry";
	structuredContent?: JsonValue;
	truncated: boolean;
};
export type McpToolExecutor = (
	snapshot: McpCatalogSnapshot,
	toolName: string,
	input: unknown,
	signal?: AbortSignal
) => Promise<McpNormalizedResult>;

export type McpToolCallExecutor = (
	snapshot: McpCatalogSnapshot,
	toolName: string,
	input: unknown,
	signal?: AbortSignal
) => Promise<ToolCallOutput>;

export const createMcpToolExecutor = (
	execute: McpToolExecutor | undefined
): McpToolCallExecutor | undefined => {
	if (isUndefined(execute)) {
		return;
	}
	return async (snapshot, toolName, input, signal) => {
		const result = await execute(snapshot, toolName, input, signal);
		return result.isError
			? { errorText: "MCP tool call failed.", type: "failure" }
			: { output: result, type: "success" };
	};
};
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 24 * 1024;
const MAX_INLINE_RESOURCE_TEXT_BYTES = 32 * 1024;
const MAX_RESOURCE_TEXT_PREVIEW_CHARS = 4096;

const size = (value: unknown): number => utf8ByteLength(JSON.stringify(value));

const writeArtifact = async (
	content: Uint8Array | string,
	extension: "bin" | "json" | "txt"
): Promise<string> => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wincode-mcp-"));
	const filePath = path.join(directory, `${crypto.randomUUID()}.${extension}`);
	await fs.writeFile(filePath, content, { flag: "wx", mode: 0o600 });
	return filePath;
};

const artifactText = async (
	content: string,
	mimeType: string
): Promise<string> => {
	const preview = middleExcerpt(content, MAX_RESOURCE_TEXT_PREVIEW_CHARS);
	if (utf8ByteLength(content) > MAX_ARTIFACT_BYTES) {
		return `[MCP content ${mimeType} exceeds the 16 MiB artifact limit]\n\n${preview}`;
	}
	const filePath = await writeArtifact(content, "txt");
	return `[MCP ${mimeType} content saved to ${filePath}]\n\n${preview}`;
};

const artifactBinary = async (
	base64: string,
	mimeType: string
): Promise<string> => {
	const estimatedBytes = Math.floor((base64.length * 3) / 4);
	if (estimatedBytes > MAX_ARTIFACT_BYTES) {
		return `[MCP binary ${mimeType} content exceeds the 16 MiB artifact limit]`;
	}
	try {
		const bytes = Uint8Array.fromBase64(base64);
		const filePath = await writeArtifact(bytes, "bin");
		return `[MCP binary ${mimeType} content saved to ${filePath}]`;
	} catch {
		return `[MCP server returned invalid ${mimeType} base64 data]`;
	}
};

const normalizeImageData = async (
	data: string,
	mimeType: string
): Promise<unknown> => {
	const estimatedBytes = Math.floor((data.length * 3) / 4);
	if (estimatedBytes <= MAX_INLINE_IMAGE_BYTES) {
		return { type: "image", data, mimeType };
	}
	return { type: "text", text: await artifactBinary(data, mimeType) };
};

const normalizeResourceBlob = async (
	blob: string,
	mimeType: string
): Promise<unknown> => {
	const estimatedBytes = Math.floor((blob.length * 3) / 4);
	if (
		mimeType.startsWith("image/") &&
		estimatedBytes <= MAX_INLINE_IMAGE_BYTES
	) {
		return { type: "image", data: blob, mimeType };
	}
	return { type: "text", text: await artifactBinary(blob, mimeType) };
};

const normalizeResourceContent = async (
	item: Record<string, unknown>,
	resource: Record<string, unknown>
): Promise<unknown> => {
	const mimeType = bounded(stringValue(resource.mimeType));
	if (isString(resource.text)) {
		if (utf8ByteLength(resource.text) <= MAX_INLINE_RESOURCE_TEXT_BYTES) {
			return item;
		}
		return { type: "text", text: await artifactText(resource.text, mimeType) };
	}
	if (isString(resource.blob)) {
		return normalizeResourceBlob(resource.blob, mimeType);
	}
	return item;
};

const normalizeBinaryContent = async (
	item: Record<string, unknown>
): Promise<unknown> => {
	const mimeType = bounded(stringValue(item.mimeType));
	if (item.type === "image" && isString(item.data)) {
		return normalizeImageData(item.data, mimeType);
	}
	if (item.type === "audio" && isString(item.data)) {
		return { type: "text", text: await artifactBinary(item.data, mimeType) };
	}
	if (item.type === "resource" && isPlainObject(item.resource)) {
		return normalizeResourceContent(item, item.resource);
	}
	return item;
};

export async function normalizeMcpResultWithArtifacts(
	input: unknown
): Promise<McpNormalizedResult> {
	const source = isPlainObject(input) ? input : {};
	const content = isArray(source.content)
		? await Promise.all(
				source.content.map((item) =>
					isPlainObject(item) ? normalizeBinaryContent(item) : item
				)
			)
		: source.content;
	const result = normalizeMcpResult({ ...source, content });
	if (!result.truncated) {
		return result;
	}
	const complete = safeJson(source);
	let artifactMessage = "[MCP output exceeded the 16 MiB artifact limit]";
	if (complete !== undefined) {
		const serialized = JSON.stringify(complete);
		if (utf8ByteLength(serialized) <= MAX_ARTIFACT_BYTES) {
			const filePath = await writeArtifact(serialized, "json");
			artifactMessage = `[Complete MCP output saved to ${filePath}]`;
		}
	}
	const boundedResult = normalizeMcpResult({
		content: [{ type: "text", text: artifactMessage }, ...result.content],
		isError: result.isError,
		structuredContent: result.structuredContent,
	});
	boundedResult.truncated = true;
	return boundedResult;
}

export async function normalizeMcpResourceContents(
	contents: readonly McpClientResourceContent[]
): Promise<JsonValue[]> {
	return Promise.all(
		contents.map(async (content): Promise<JsonValue> => {
			const mimeType = bounded(stringValue(content.mimeType));
			if ("text" in content && isString(content.text)) {
				if (utf8ByteLength(content.text) <= MAX_INLINE_RESOURCE_TEXT_BYTES) {
					return {
						type: "text",
						uri: bounded(content.uri),
						text: content.text,
					};
				}
				return {
					type: "text",
					uri: bounded(content.uri),
					text: await artifactText(content.text, mimeType),
				};
			}
			if ("blob" in content && isString(content.blob)) {
				if (mimeType.startsWith("image/")) {
					const estimatedBytes = Math.floor((content.blob.length * 3) / 4);
					if (estimatedBytes <= MAX_INLINE_IMAGE_BYTES) {
						return {
							type: "image",
							uri: bounded(content.uri),
							data: content.blob,
							mimeType,
						};
					}
				}
				return {
					type: "binary-artifact",
					uri: bounded(content.uri),
					mimeType,
					text: await artifactBinary(content.blob, mimeType),
				};
			}
			return {
				type: "text",
				uri: bounded(content.uri),
				text: "[MCP server returned an unsupported resource content type]",
			};
		})
	);
}
const stringValue = (value: unknown): string =>
	isString(value) ? value : "unknown";
const HIGH_SURROGATE_START = 0xd8_00;
const HIGH_SURROGATE_END = 0xdb_ff;
const LOW_SURROGATE_START = 0xdc_00;
const LOW_SURROGATE_END = 0xdf_ff;
const prefix = (value: string, length: number): string => {
	const end = Math.min(value.length, length);
	const chunks: string[] = [];
	let index = 0;
	while (index < end) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= HIGH_SURROGATE_START && codeUnit <= HIGH_SURROGATE_END) {
			const nextCodeUnit = value.charCodeAt(index + 1);
			const hasLowSurrogate =
				index + 1 < value.length &&
				nextCodeUnit >= LOW_SURROGATE_START &&
				nextCodeUnit <= LOW_SURROGATE_END;
			if (hasLowSurrogate && index + 1 >= end) {
				break;
			}
			if (hasLowSurrogate) {
				chunks.push(value.slice(index, index + 2));
				index += 2;
				continue;
			}
			chunks.push("\uFFFD");
		} else if (
			codeUnit >= LOW_SURROGATE_START &&
			codeUnit <= LOW_SURROGATE_END
		) {
			chunks.push("\uFFFD");
		} else {
			chunks.push(value.charAt(index));
		}
		index += 1;
	}
	return chunks.join("");
};
const suffix = (value: string, length: number): string => {
	let start = Math.max(0, value.length - length);
	if (
		start > 0 &&
		value.charCodeAt(start) >= LOW_SURROGATE_START &&
		value.charCodeAt(start) <= LOW_SURROGATE_END &&
		value.charCodeAt(start - 1) >= HIGH_SURROGATE_START &&
		value.charCodeAt(start - 1) <= HIGH_SURROGATE_END
	) {
		start += 1;
	}
	return prefix(value.slice(start), value.length - start);
};
const middleExcerpt = (value: string, keep: number): string => {
	if (keep >= value.length) {
		return prefix(value, keep);
	}
	const marker = "\n[… middle omitted …]\n";
	if (keep <= marker.length) {
		return prefix(value, keep);
	}
	const contentLength = keep - marker.length;
	const headLength = Math.ceil(contentLength / 2);
	const tailLength = contentLength - headLength;
	return `${prefix(value, headLength)}${marker}${suffix(value, tailLength)}`;
};
const bounded = (value: string, max = 2048): string => {
	const end = Math.min(value.length, max);
	const chunks: string[] = [];
	let index = 0;
	while (index < end) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 55_296 && codeUnit <= 56_319) {
			if (
				index + 1 < end &&
				value.charCodeAt(index + 1) >= 56_320 &&
				value.charCodeAt(index + 1) <= 57_343
			) {
				chunks.push(value.slice(index, index + 2));
				index += 2;
				continue;
			}
			chunks.push("\uFFFD");
		} else if (codeUnit >= 56_320 && codeUnit <= 57_343) {
			chunks.push("\uFFFD");
		} else {
			chunks.push(value[index] ?? "");
		}
		index += 1;
	}
	return chunks.join("");
};
function safeJson(
	value: unknown,
	ancestors = new WeakSet<object>(),
	depth = 0
): JsonValue | undefined {
	if (isNull(value) || isString(value) || isBoolean(value)) {
		return value;
	}
	if (isNumber(value)) {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value !== "object" || depth > 32 || ancestors.has(value)) {
		return;
	}
	ancestors.add(value);
	let result: JsonValue | undefined;
	if (isArray(value)) {
		result = value.flatMap((item) => {
			const safe = safeJson(item, ancestors, depth + 1);
			return isUndefined(safe) ? [] : [safe];
		});
	} else {
		result = Object.fromEntries(
			Object.entries(value).flatMap(([key, item]) => {
				const safe = safeJson(item, ancestors, depth + 1);
				return isUndefined(safe) ? [] : [[bounded(key), safe]];
			})
		);
	}
	ancestors.delete(value);
	return result;
}
function normalizeContent(value: unknown): JsonValue[] {
	if (!isArray(value)) {
		return [];
	}
	return value.flatMap((item): JsonValue[] => {
		if (!isPlainObject(item)) {
			return [];
		}
		if (item.type === "text" && isString(item.text)) {
			return [{ type: "text", text: item.text }];
		}
		if (item.type === "image" && isString(item.data)) {
			return [
				{
					type: "image",
					data: item.data,
					mimeType: stringValue(item.mimeType),
				},
			];
		}
		if (item.type === "image" || item.type === "audio") {
			return [
				{
					type: "binary-metadata",
					mediaType: stringValue(item.mimeType),
					originalType: item.type,
				},
			];
		}
		if (item.type === "resource" && isPlainObject(item.resource)) {
			const resource = item.resource;
			if (isString(resource.text)) {
				return [
					{
						type: "resource",
						uri: bounded(stringValue(resource.uri)),
						text: resource.text,
						mediaType: stringValue(resource.mimeType),
					},
				];
			}
			return [
				{
					type: "binary-metadata",
					mediaType: stringValue(resource.mimeType),
					originalType: "resource",
				},
			];
		}
		if (item.type === "resource_link") {
			return [
				{
					type: "resource_link",
					uri: bounded(stringValue(item.uri)),
					name: bounded(stringValue(item.name)),
					description: bounded(stringValue(item.description)),
				},
			];
		}
		return [];
	});
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded normalization handles protocol variants and cap fallback in one pass
export function normalizeMcpResult(input: unknown): McpNormalizedResult {
	const cap = MAX_MCP_RESULT_BYTES;
	const source = isPlainObject(input) ? input : {};
	const result: McpNormalizedResult = {
		content: normalizeContent(source.content),
		isError: source.isError === true,
		truncated: false,
	};
	const structured = safeJson(source.structuredContent);
	if (!isUndefined(structured)) {
		result.structuredContent = structured;
	}
	if (size(result) <= cap) {
		return result;
	}
	result.truncated = true;
	const marker = { type: "text", text: "[MCP output truncated]" } as JsonValue;
	const texts = result.content.filter(
		(item): item is { text: string } =>
			isPlainObject(item) && isString(item.text)
	);
	const originals = texts.map((text) => text.text);
	const lengths = texts.map((text) => text.text.length);
	for (const text of texts) {
		text.text = "";
	}
	result.content = [...result.content, marker];
	if (size(result) > cap) {
		result.structuredContent = undefined;
	}
	if (size(result) > cap) {
		result.content = [marker];
	}
	if (size(result) > cap) {
		return { content: [], isError: result.isError, truncated: true };
	}
	let low = 0;
	let high = lengths.reduce((sum, length) => sum + length, 0);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		let left = mid;
		for (let index = 0; index < texts.length; index += 1) {
			const text = texts[index];
			if (!text) {
				continue;
			}
			text.text = middleExcerpt(
				originals[index] ?? "",
				Math.min(left, lengths[index] ?? 0)
			);
			left = Math.max(0, left - (lengths[index] ?? 0));
		}
		if (size(result) <= cap) {
			low = mid;
		} else {
			high = mid - 1;
		}
	}
	let left = low;
	for (let index = 0; index < texts.length; index += 1) {
		const text = texts[index];
		if (!text) {
			continue;
		}
		text.text = middleExcerpt(
			originals[index] ?? "",
			Math.min(left, lengths[index] ?? 0)
		);
		left = Math.max(0, left - (lengths[index] ?? 0));
	}
	return result;
}

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };
export type McpNormalizedResult = {
	content: JsonValue[];
	isError: boolean;
	structuredContent?: JsonValue;
	truncated: boolean;
};
export const MAX_MCP_RESULT_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const size = (value: unknown): number =>
	encoder.encode(JSON.stringify(value)).byteLength;
const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown): string =>
	typeof value === "string" ? value : "unknown";
const bounded = (value: string, max = 2048): string =>
	Array.from(value).slice(0, max).join("");
function safeJson(
	value: unknown,
	seen = new WeakSet<object>(),
	depth = 0
): JsonValue | undefined {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value !== "object" || depth > 32 || seen.has(value)) {
		return;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			const safe = safeJson(item, seen, depth + 1);
			return safe === undefined ? [] : [safe];
		});
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) => {
			const safe = safeJson(item, seen, depth + 1);
			return safe === undefined ? [] : [[bounded(key), safe]];
		})
	);
}
function normalizeContent(value: unknown): JsonValue[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item): JsonValue[] => {
		if (!record(item)) {
			return [];
		}
		if (item.type === "text" && typeof item.text === "string") {
			return [{ type: "text", text: item.text }];
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
		if (item.type === "resource" && record(item.resource)) {
			const resource = item.resource;
			if (typeof resource.text === "string") {
				return [
					{
						type: "resource",
						uri: bounded(stringValue(resource.uri)),
						text: bounded(resource.text),
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
export function normalizeMcpResult(
	input: unknown,
	requestedCap?: number
): McpNormalizedResult {
	const cap = Math.max(
		1,
		Math.min(requestedCap ?? MAX_MCP_RESULT_BYTES, MAX_MCP_RESULT_BYTES)
	);
	const source = record(input) ? input : {};
	const result: McpNormalizedResult = {
		content: normalizeContent(source.content),
		isError: source.isError === true,
		truncated: false,
	};
	const structured = safeJson(source.structuredContent);
	if (structured !== undefined) {
		result.structuredContent = structured;
	}
	if (size(result) <= cap) {
		return result;
	}
	result.truncated = true;
	result.structuredContent = { truncated: true };
	const marker = { type: "text", text: "[MCP output truncated]" } as JsonValue;
	const texts = result.content.filter(
		(item): item is { type: "text"; text: string } =>
			record(item) && item.type === "text" && typeof item.text === "string"
	);
	const originals = texts.map((text) => text.text);
	const lengths = texts.map((text) => Array.from(text.text).length);
	for (const text of texts) {
		text.text = "";
	}
	result.content = [...result.content, marker];
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
			const chars = Array.from(originals[index] ?? "");
			text.text = chars.slice(0, Math.min(left, lengths[index] ?? 0)).join("");
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
		const chars = Array.from(originals[index] ?? "");
		text.text = chars.slice(0, Math.min(left, lengths[index] ?? 0)).join("");
		left = Math.max(0, left - (lengths[index] ?? 0));
	}
	return result;
}

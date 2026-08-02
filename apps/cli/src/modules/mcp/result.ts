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

export const MAX_MCP_RESULT_BYTES = 64 * 1024;

export function normalizeMcpResult(
	input: unknown,
	maxBytes = MAX_MCP_RESULT_BYTES
): McpNormalizedResult {
	const result = isRecord(input) ? input : {};
	const normalized: McpNormalizedResult = {
		content: normalizeContent(result.content),
		isError: result.isError === true,
		truncated: false,
	};
	const structured = safeJson(result.structuredContent);
	if (structured !== undefined) {
		normalized.structuredContent = structured;
	}
	if (encodedSize(normalized) <= maxBytes) {
		return normalized;
	}
	normalized.truncated = true;
	for (const item of normalized.content) {
		if (
			isRecord(item) &&
			item.type === "text" &&
			typeof item.text === "string"
		) {
			item.text = truncateUtf8(
				item.text,
				Math.max(
					0,
					maxBytes - encodedSize({ ...normalized, content: [] }) - 100
				)
			);
		}
	}
	normalized.content.push({ type: "text", text: "[MCP output truncated]" });
	while (encodedSize(normalized) > maxBytes && normalized.content.length > 1) {
		normalized.content.pop();
	}
	return normalized;
}

const normalizeContent = (value: unknown): JsonValue[] => {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item): JsonValue[] => {
		if (!isRecord(item)) {
			return [];
		}
		if (item.type === "text" && typeof item.text === "string") {
			return [{ type: "text", text: item.text }];
		}
		if (item.type === "image" || item.type === "audio") {
			return [{ type: item.type, mimeType: stringOrUnknown(item.mimeType) }];
		}
		if (item.type === "resource" || item.type === "resource_link") {
			return [
				{
					type: item.type,
					uri: stringOrUnknown(item.uri),
					name: stringOrUnknown(item.name),
				},
			];
		}
		return [];
	});
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const stringOrUnknown = (value: unknown): string =>
	typeof value === "string" ? value : "unknown";
const encodedSize = (value: unknown): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;
const safeJson = (value: unknown): JsonValue | undefined => {
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
	if (Array.isArray(value)) {
		return value
			.map(safeJson)
			.filter((item): item is JsonValue => item !== undefined);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.entries(value).flatMap(([key, item]) => {
				const safe = safeJson(item);
				return safe === undefined ? [] : [[key, safe]];
			})
		);
	}
	return;
};
const truncateUtf8 = (value: string, bytes: number): string => {
	const encoder = new TextEncoder();
	let result = value;
	while (encoder.encode(result).byteLength > bytes) {
		result = result.slice(0, -1);
	}
	return result;
};

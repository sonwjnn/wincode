import {
	isArray,
	isObjectLike,
	isSensitiveKey as isSensitiveRuntimeKey,
	isString,
	REDACTED,
	sanitizeText,
	stripControlCharacters,
} from "@wincode/utils";

export type { RedactOptions, SanitizeTextOptions } from "@wincode/utils";
export {
	isSensitiveKey,
	REDACTED,
	redactSensitiveText,
	sanitizeText,
	stripControlCharacters,
} from "@wincode/utils";

export type ArgumentTreeOptions = {
	/** Per-string character cap (default 512). */
	maxChars?: number;
	/** Maximum recursion depth for objects and arrays (default 2). */
	maxDepth?: number;
	/** Maximum entries per object or array (default 12). */
	maxEntries?: number;
	/** Marker for nodes cut by the depth bound (default `[…]`). */
	depthOverflow?: string;
	/** Also redact secret-looking values inside object keys (default false). */
	redactValuesInKeys?: boolean;
};

/**
 * Recursively sanitizes an unknown value for display: strings are stripped
 * and redacted, secret key names are redacted wholesale, cycles are replaced
 * with `[circular]`, and objects and arrays are bounded by depth and entry
 * limits so a hostile or enormous tool schema cannot flood the UI.
 */
export function sanitizeArgumentTree(
	value: unknown,
	options: ArgumentTreeOptions = {}
): unknown {
	const {
		maxChars = 512,
		maxDepth = 2,
		maxEntries = 12,
		depthOverflow = "[…]",
		redactValuesInKeys = false,
	} = options;

	const sanitizeString = (text: string): string =>
		sanitizeText(text, { maxChars });
	const sanitizeKey = (key: string): string =>
		redactValuesInKeys
			? sanitizeString(key)
			: stripControlCharacters(key, maxChars);

	const walk = (
		node: unknown,
		depth: number,
		seen: WeakSet<object>
	): unknown => {
		if (isString(node)) {
			return sanitizeString(node);
		}
		if (!isObjectLike(node)) {
			return node;
		}
		if (seen.has(node)) {
			return "[circular]";
		}
		if (depth >= maxDepth) {
			return depthOverflow;
		}

		seen.add(node);
		if (isArray(node)) {
			return node
				.slice(0, maxEntries)
				.map((entry) => walk(entry, depth + 1, seen));
		}

		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(node).slice(0, maxEntries)) {
			result[sanitizeKey(key)] = isSensitiveRuntimeKey(key)
				? REDACTED
				: walk(entry, depth + 1, seen);
		}
		return result;
	};

	return walk(value, 0, new WeakSet());
}

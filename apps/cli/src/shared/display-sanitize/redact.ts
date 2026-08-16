const URL_LIKE_PATTERN = /https?:\/\/[^\s,;]+/gi;
const SECRET_KEY_NAME_PATTERN =
	/(?:apikey|auth|authorization|bearer|cookie|credential|password|privatekey|secret|session|token)/i;
const SECRET_VALUE_PATTERN =
	/\b(?:(api[ _-]?key|auth(?:orization)?|cookie|credential|password|private[ _-]?key|secret|session|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;}\]]+|bearer\s+[^\s,;}\]]+)/gi;

export const REDACTED = "[redacted]";

export type RedactOptions = {
	/** Preserve the key name so a redacted value reads `token=[redacted]`. */
	keepKey?: boolean;
	/** Redact any `https?://` URL. */
	redactUrls?: boolean;
	/** Exact secret strings to replace wherever they appear. */
	secrets?: readonly string[];
};

export type SanitizeTextOptions = RedactOptions & {
	/** Maximum length of the result (default 512). */
	maxChars?: number;
};

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
 * Replaces C0 (0–31) and C1 (127–159) control characters with spaces, so
 * hostile or corrupted text can never inject layout or escape sequences.
 * Optionally bounds the result to `maxChars`.
 */
export const stripControlCharacters = (
	value: string,
	maxChars?: number
): string => {
	const stripped = Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
	}).join("");
	return maxChars === undefined ? stripped : stripped.slice(0, maxChars);
};

/** True when the key name itself is a secret (after stripping punctuation). */
export const isSensitiveKey = (key: string): boolean =>
	SECRET_KEY_NAME_PATTERN.test(
		stripControlCharacters(key).replace(/[^a-z0-9]/gi, "")
	);

/**
 * Redacts secret material for display. Exact `secrets` are substituted first,
 * then URLs when requested, then secret-looking `key=value` tokens. With
 * `keepKey`, the key name survives so a redacted value reads `token=[redacted]`;
 * without it, the whole match is replaced.
 */
export function redactSensitiveText(
	value: string,
	options: RedactOptions = {}
): string {
	let result = value;
	for (const secret of options.secrets ?? []) {
		if (secret.length > 0) {
			result = result.split(secret).join(REDACTED);
		}
	}
	if (options.redactUrls) {
		result = result.replace(URL_LIKE_PATTERN, REDACTED);
	}
	return result.replace(SECRET_VALUE_PATTERN, (_match, key) =>
		options.keepKey && typeof key === "string" && key.length > 0
			? `${key}=${REDACTED}`
			: REDACTED
	);
}

/** Strips control characters, redacts secrets, and bounds the result. */
export function sanitizeText(
	value: string,
	options: SanitizeTextOptions = {}
): string {
	return redactSensitiveText(stripControlCharacters(value), options).slice(
		0,
		options.maxChars ?? 512
	);
}

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
		if (typeof node === "string") {
			return sanitizeString(node);
		}
		if (typeof node !== "object" || node === null) {
			return node;
		}
		if (seen.has(node)) {
			return "[circular]";
		}
		if (depth >= maxDepth) {
			return depthOverflow;
		}

		seen.add(node);
		if (Array.isArray(node)) {
			return node
				.slice(0, maxEntries)
				.map((entry) => walk(entry, depth + 1, seen));
		}

		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(node).slice(0, maxEntries)) {
			result[sanitizeKey(key)] = isSensitiveKey(key)
				? REDACTED
				: walk(entry, depth + 1, seen);
		}
		return result;
	};

	return walk(value, 0, new WeakSet());
}

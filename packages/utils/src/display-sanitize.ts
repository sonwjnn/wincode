import { isNonEmptyString, isUndefined } from "./guards";

const URL_LIKE_PATTERN = /https?:\/\/[^\s,;]+/gi;
const SECRET_VALUE_PATTERN =
	/\b(?:(api[ _-]?key|auth(?:orization)?|cookie|credential|password|private[ _-]?key|secret|session|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;}\]]+|bearer\s+[^\s,;}\]]+)/gi;

export const REDACTED = "[redacted]";

export type RedactOptions = Readonly<{
	/** Preserve the key name so a redacted value reads `token=[redacted]`. */
	keepKey?: boolean;
	/** Redact any `https?://` URL. */
	redactUrls?: boolean;
	/** Exact secret strings to replace wherever they appear. */
	secrets?: readonly string[];
}>;

export type SanitizeTextOptions = RedactOptions &
	Readonly<{
		/** Maximum length of the result (default 512). */
		maxChars?: number;
	}>;

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
	return isUndefined(maxChars) ? stripped : stripped.slice(0, maxChars);
};

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
	return result.replace(SECRET_VALUE_PATTERN, (_match, key: unknown) =>
		options.keepKey && isNonEmptyString(key) ? `${key}=${REDACTED}` : REDACTED
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

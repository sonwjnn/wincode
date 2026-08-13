const MAX_INPUT_CHARS = 2048;
const MAX_INPUT_DEPTH = 4;
const MAX_INPUT_ENTRIES = 24;
const MAX_INPUT_STRING_CHARS = 512;
export const MAX_DESCRIPTION_CHARS = 2048;
export const MAX_IDENTITY_CHARS = 512;
export const MAX_FEEDBACK_CHARS = 2048;
const FORMATTED_INPUT_OVERFLOW = "…";
const REDACTED_INPUT = "[redacted]";
const SENSITIVE_INPUT_KEY_REGEX =
	/(?:apikey|auth|authorization|bearer|cookie|credential|password|privatekey|secret|session|token)/i;
const SENSITIVE_INPUT_VALUE_REGEX =
	/\b(?:(?:api[ _-]?key|auth(?:orization)?|cookie|credential|password|private[ _-]?key|secret|session|token)\s*[:=]\s*(?:bearer\s+)?[^\s,;}\]]+|bearer\s+[^\s,;}\]]+)/gi;

const stripInputControlCharacters = (value: string): string =>
	Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
	}).join("");

const truncateWithOverflow = (text: string, maxChars: number): string => {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}${FORMATTED_INPUT_OVERFLOW}`;
};

const sanitizeInputString = (value: string): string =>
	truncateWithOverflow(
		stripInputControlCharacters(value).replace(
			SENSITIVE_INPUT_VALUE_REGEX,
			REDACTED_INPUT
		),
		MAX_INPUT_STRING_CHARS
	);

const isSensitiveInputKey = (key: string): boolean =>
	SENSITIVE_INPUT_KEY_REGEX.test(
		stripInputControlCharacters(key).replace(/[^a-z0-9]/gi, "")
	);

const sanitizeApprovalInput = (
	input: unknown,
	depth: number,
	seen: WeakSet<object>
): unknown => {
	if (typeof input === "string") {
		return sanitizeInputString(input);
	}
	if (typeof input !== "object" || input === null) {
		return input;
	}
	if (seen.has(input)) {
		return "[circular]";
	}
	if (depth >= MAX_INPUT_DEPTH) {
		return FORMATTED_INPUT_OVERFLOW;
	}
	seen.add(input);
	if (Array.isArray(input)) {
		return input
			.slice(0, MAX_INPUT_ENTRIES)
			.map((entry) => sanitizeApprovalInput(entry, depth + 1, seen));
	}
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input).slice(
		0,
		MAX_INPUT_ENTRIES
	)) {
		const sanitizedKey = sanitizeInputString(key);
		result[sanitizedKey] = isSensitiveInputKey(key)
			? REDACTED_INPUT
			: sanitizeApprovalInput(value, depth + 1, seen);
	}
	return result;
};

/**
 * Formats the tool-call input for display, bounded so a hostile or enormous
 * tool schema cannot flood the dialog. Never renders config, credentials,
 * headers, or URLs — only the tool-call arguments the model produced.
 */
export function formatApprovalInput(input: unknown): string {
	const text =
		JSON.stringify(sanitizeApprovalInput(input, 0, new WeakSet()), null, 2) ??
		"";
	return truncateWithOverflow(text, MAX_INPUT_CHARS);
}

/**
 * Formats the tool description for display, bounded so a hostile or enormous
 * tool schema cannot flood the dialog.
 */
export function formatApprovalDescription(description: string): string {
	return truncateWithOverflow(description, MAX_DESCRIPTION_CHARS);
}

export function formatApprovalIdentity(identity: string): string {
	return truncateWithOverflow(identity, MAX_IDENTITY_CHARS);
}

/**
 * Bounds the user's rejection feedback before it is returned to the Agent, so a
 * pasted or runaway correction cannot flood the Agent's next turn. Returns
 * undefined when the trimmed feedback is empty so no empty correction is sent.
 */
export function formatRejectionFeedback(
	feedback: string | undefined
): string | undefined {
	if (feedback === undefined) {
		return;
	}
	const trimmed = feedback.trim();
	if (trimmed.length === 0) {
		return;
	}
	return truncateWithOverflow(trimmed, MAX_FEEDBACK_CHARS);
}

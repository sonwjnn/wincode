import { SHELL_OUTPUT_TAIL_BYTES } from "@wincode/coding-tools";
import { redactSensitiveText } from "./redact";

const CRLF_PATTERN = /\r\n/g;
const CARRIAGE_RETURN_PATTERN = /\r/g;
const TRAILING_NEWLINE_PATTERN = /\n$/;

/** Printable output characters: tab, newline, and everything above C1. */
const isPrintableShellOutputCharacter = (code: number): boolean =>
	code === 0x09 ||
	code === 0x0a ||
	(code >= 0x20 && (code < 0x7f || code > 0x9f));

const stripShellOutputControlCharacters = (value: string): string =>
	Array.from(value, (character) =>
		isPrintableShellOutputCharacter(character.charCodeAt(0)) ? character : ""
	).join("");

/** Strips ANSI escape sequences from command output using Bun's native utility. */
export const stripAnsi = (value: string): string =>
	globalThis.Bun.stripANSI(value);

/**
 * Normalizes command-output newlines: CRLF collapses to LF, bare carriage
 * returns are dropped, and the trailing newline is removed because it
 * terminates the last line rather than creating an empty final line, so
 * bounded previews count real lines only.
 */
const normalizeShellNewlines = (value: string): string =>
	value
		.replace(CRLF_PATTERN, "\n")
		.replace(CARRIAGE_RETURN_PATTERN, "")
		.replace(TRAILING_NEWLINE_PATTERN, "");

/**
 * Sanitizes command output for display: ANSI escape sequences are stripped,
 * control characters are removed while newlines and tabs survive so
 * multi-line output renders faithfully, secrets are redacted, and the result
 * is bounded to `maxChars`.
 */
export function sanitizeShellOutput(
	value: string,
	maxChars = SHELL_OUTPUT_TAIL_BYTES
): string {
	return redactSensitiveText(
		stripShellOutputControlCharacters(normalizeShellNewlines(stripAnsi(value)))
	).slice(0, maxChars);
}

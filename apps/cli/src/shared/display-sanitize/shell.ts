import { SHELL_OUTPUT_TAIL_BYTES } from "@wincode/ai";
import { redactSensitiveText } from "./redact";

const SHELL_OUTPUT_ESC = String.fromCharCode(0x1b);
const SHELL_OUTPUT_BELL = String.fromCharCode(0x07);
const ANSI_CSI_PATTERN = new RegExp(
	`${SHELL_OUTPUT_ESC}\\[[0-9;]*[A-Za-z]`,
	"g"
);
const ANSI_OSC_PATTERN = new RegExp(
	`${SHELL_OUTPUT_ESC}][^${SHELL_OUTPUT_BELL}]*${SHELL_OUTPUT_BELL}`,
	"g"
);
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

/**
 * Strips ANSI escape sequences from command output: CSI (colors, cursor
 * moves) and OSC (terminal titles) sequences are removed.
 */
export function stripAnsi(value: string): string {
	return value.replace(ANSI_CSI_PATTERN, "").replace(ANSI_OSC_PATTERN, "");
}

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

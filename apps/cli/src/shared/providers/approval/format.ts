const MAX_INPUT_CHARS = 2048;
export const MAX_DESCRIPTION_CHARS = 2048;
export const MAX_IDENTITY_CHARS = 512;
const FORMATTED_INPUT_OVERFLOW = "…";

const truncateWithOverflow = (text: string, maxChars: number): string => {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, maxChars)}${FORMATTED_INPUT_OVERFLOW}`;
};

/**
 * Formats the tool-call input for display, bounded so a hostile or enormous
 * tool schema cannot flood the dialog. Never renders config, credentials,
 * headers, or URLs — only the tool-call arguments the model produced.
 */
export function formatApprovalInput(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input, null, 2);
	} catch {
		text = String(input);
	}
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

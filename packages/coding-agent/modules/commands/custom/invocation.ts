export type CustomCommandInvocation = {
	name: string;
	arguments: string;
};

const INVOCATION_PATTERN = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i;

export function parseCustomCommandInvocation(
	input: string
): CustomCommandInvocation | null {
	const match = input.trim().match(INVOCATION_PATTERN);
	if (!match?.[1]) {
		return null;
	}
	return { name: match[1], arguments: match[2]?.trim() ?? "" };
}

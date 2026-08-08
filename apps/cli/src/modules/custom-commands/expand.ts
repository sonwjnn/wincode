const TOKEN_PATTERN = /\$\$|\$ARGUMENTS|\$\d+/g;
const WHITESPACE_PATTERN = /\s+/;
const FIRST_WHITESPACE_PATTERN = /\s/;

export function extractArguments(query: string): string {
	const firstWhitespace = query.search(FIRST_WHITESPACE_PATTERN);
	if (firstWhitespace === -1) {
		return "";
	}
	return query.slice(firstWhitespace + 1).trim();
}

export function expandCustomCommandTemplate(
	template: string,
	args: string
): string {
	const positional = args.trim() ? args.split(WHITESPACE_PATTERN) : [];
	return template.replace(TOKEN_PATTERN, (token) => {
		if (token === "$$") {
			return "$";
		}
		if (token === "$ARGUMENTS") {
			return args;
		}
		const index = Number(token.slice(1)) - 1;
		return positional[index] ?? "";
	});
}

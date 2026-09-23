const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\n?---(?:\r?\n|$)/;
const LINE_PATTERN = /\r?\n/;

export class CustomCommandValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomCommandValidationError";
	}
}

const scalar = (value: string): string =>
	value.trim().replace(/^['"]|['"]$/g, "");

export function parseCustomCommandFile(source: string): {
	description: string;
	template: string;
} {
	let body = source;
	let description = "";
	if (source.startsWith("---")) {
		const match = source.match(FRONTMATTER_PATTERN);
		if (!match) {
			throw new CustomCommandValidationError(
				"Custom command file has invalid YAML frontmatter delimiters"
			);
		}
		const yaml = match[1] ?? "";
		for (const line of yaml.split(LINE_PATTERN)) {
			const separator = line.indexOf(":");
			if (separator < 1) {
				continue;
			}
			const key = line.slice(0, separator).trim();
			if (key === "description") {
				description = scalar(line.slice(separator + 1));
			}
		}
		body = source.slice(match[0].length);
	}
	return { description, template: body.trim() };
}

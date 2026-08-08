import type { CustomCommandSpec } from "./types";

const WHITESPACE_PATTERN = /\s+/;

export function filterCustomCommands(
	commands: CustomCommandSpec[],
	query: string
): CustomCommandSpec[] {
	if (query.length === 0) {
		return commands;
	}
	const firstToken = query.split(WHITESPACE_PATTERN, 1)[0]?.toLowerCase() ?? "";
	return commands.filter((command) =>
		command.name.toLowerCase().startsWith(firstToken)
	);
}

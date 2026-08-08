import type { CommandSpec } from "./commands";
import { COMMANDS } from "./commands";

const WHITESPACE_PATTERN = /\s+/;

export function getFilteredCommands(query: string): CommandSpec[] {
	if (query.length === 0) {
		return COMMANDS;
	}
	const firstToken = query.split(WHITESPACE_PATTERN, 1)[0]?.toLowerCase() ?? "";
	return COMMANDS.filter((cmd) =>
		cmd.name.toLowerCase().startsWith(firstToken)
	);
}

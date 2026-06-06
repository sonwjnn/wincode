import type { CommandSpec } from "./commands";
import { COMMANDS } from "./commands";

export function getFilteredCommands(query: string): CommandSpec[] {
	if (query.length === 0) {
		return COMMANDS;
	}
	return COMMANDS.filter((cmd) =>
		cmd.name.toLowerCase().startsWith(query.toLowerCase())
	);
}

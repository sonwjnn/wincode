import type { CustomCommandSpec } from "./types";

export function filterCustomCommands(
	commands: CustomCommandSpec[],
	query: string
): CustomCommandSpec[] {
	if (query.length === 0) {
		return commands;
	}
	return commands.filter((command) =>
		command.name.toLowerCase().startsWith(query.toLowerCase())
	);
}

import type { CommandSpec } from "./commands";
import { COMMANDS } from "./commands";

export function getFilteredCommands(
	query: string,
	options: { hideVariants?: boolean } = {}
): CommandSpec[] {
	const commands =
		query.length === 0
			? COMMANDS
			: COMMANDS.filter((cmd) =>
					cmd.name.toLowerCase().startsWith(query.toLowerCase())
				);
	return options.hideVariants
		? commands.filter((cmd) => cmd.kind !== "variants")
		: commands;
}

import type { CommandSpec } from "./commands";
import { COMMANDS } from "./commands";

export function getFilteredCommands(
	query: string,
	options: { hideCompact?: boolean; hideVariants?: boolean } = {}
): CommandSpec[] {
	const commands =
		query.length === 0
			? COMMANDS
			: COMMANDS.filter((cmd) =>
					cmd.name.toLowerCase().startsWith(query.toLowerCase())
				);
	return commands.filter(
		(cmd) =>
			!(
				(options.hideCompact && cmd.kind === "compact") ||
				(options.hideVariants && cmd.kind === "variants")
			)
	);
}

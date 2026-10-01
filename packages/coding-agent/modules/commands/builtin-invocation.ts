import { COMMANDS, type CommandSpec } from "./commands";

const INVOCATION_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u;

/** Resolve a complete typed Built-in Command according to its input capability. */
export function findBuiltinCommand(text: string): CommandSpec | null {
	const trimmed = text.trim();
	const match = INVOCATION_PATTERN.exec(trimmed);
	if (!match) {
		return null;
	}
	const name = match[1]?.toLowerCase();
	const spec: CommandSpec | undefined = COMMANDS.find(
		(command) => command.name === name
	);
	if (!spec) {
		return null;
	}
	const argument = match[2]?.trim();
	if (spec.input.kind === "none") {
		return match[2] === undefined ? spec : null;
	}
	return argument ? ({ ...spec, argument } as CommandSpec) : spec;
}

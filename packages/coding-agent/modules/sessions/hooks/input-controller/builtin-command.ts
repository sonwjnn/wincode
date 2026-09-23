import { COMMANDS, type CommandSpec } from "@/modules/commands/commands";
import { parseCompactCommand } from "../../compaction";

const WHITESPACE_PATTERN = /\s/u;

/**
 * Resolve submitted text to the Built-in Command it invokes. `/compact` carries
 * its focus; every other Built-in Commands is an exact name match and takes no
 * arguments, so extra text leaves the line ordinary prompt text.
 */
export function findBuiltinCommand(text: string): CommandSpec | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		return null;
	}
	const compact = parseCompactCommand(trimmed);
	if (compact) {
		const spec = COMMANDS.find((command) => command.kind === "compact");
		return spec?.kind === "compact" ? { ...spec, focus: compact.focus } : null;
	}
	if (WHITESPACE_PATTERN.test(trimmed)) {
		return null;
	}
	const name = trimmed.slice(1).toLowerCase();
	return COMMANDS.find((command) => command.name === name) ?? null;
}

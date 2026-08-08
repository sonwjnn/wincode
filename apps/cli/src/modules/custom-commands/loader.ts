import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { COMMANDS } from "@/modules/commands/commands";
import { discoverCustomCommandCandidates } from "./discovery";
import { parseCustomCommandFile } from "./parse";
import type { CustomCommandCandidate, CustomCommandSpec } from "./types";

const BUILTIN_NAMES = new Set(COMMANDS.map((command) => command.name));

export async function loadCustomCommands(
	candidates: CustomCommandCandidate[]
): Promise<CustomCommandSpec[]> {
	const byName = new Map<string, CustomCommandSpec>();
	for (const candidate of candidates) {
		if (!candidate.filePath.endsWith(".md")) {
			continue;
		}
		const name = basename(candidate.filePath, ".md");
		if (BUILTIN_NAMES.has(name)) {
			console.warn(
				`Ignoring custom command "/${name}" in ${candidate.filePath}: ` +
					"it collides with a built-in command."
			);
			continue;
		}
		try {
			const parsed = parseCustomCommandFile(
				await readFile(candidate.filePath, "utf8")
			);
			byName.set(name, {
				description: parsed.description,
				kind: "custom",
				name,
				template: parsed.template,
				value: `/${name}`,
			});
		} catch {
			// Best-effort: invalid or inaccessible command files are ignored.
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCustomCommands(
	cwd = process.cwd(),
	home = homedir()
): Promise<CustomCommandSpec[]> {
	return loadCustomCommands(discoverCustomCommandCandidates(cwd, home));
}

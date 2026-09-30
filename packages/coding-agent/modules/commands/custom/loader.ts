import { basename } from "node:path";
import { logger, readUtf8File } from "@wincode/runtime-utils";
import { COMMANDS } from "@/modules/commands/commands";
import { SKILL_NAMESPACE_PREFIX } from "@/modules/skills";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { discoverCustomCommandCandidates } from "./discovery";
import { parseCustomCommandFile } from "./parse";
import type { CustomCommandCandidate, CustomCommandSpec } from "./types";

// Built-in names are matched without case: the overlay search and the typed
// resolver both compare case-insensitively, so a differently-cased filename
// would list a row the submission path can never reach.
const BUILTIN_NAMES = new Set(
	COMMANDS.map((command) => command.name.toLowerCase())
);

export async function loadCustomCommands(
	candidates: CustomCommandCandidate[]
): Promise<CustomCommandSpec[]> {
	const byName = new Map<string, CustomCommandSpec>();
	for (const candidate of candidates) {
		if (!candidate.filePath.endsWith(".md")) {
			continue;
		}
		const name = basename(candidate.filePath, ".md");
		if (BUILTIN_NAMES.has(name.toLowerCase())) {
			await logger.warn(
				"Ignoring custom command because it collides with a built-in command.",
				{ filePath: candidate.filePath, name }
			);
			continue;
		}
		if (name.toLowerCase().startsWith(SKILL_NAMESPACE_PREFIX)) {
			await logger.warn(
				"Ignoring custom command because it uses the reserved skill namespace.",
				{ filePath: candidate.filePath, name }
			);
			continue;
		}
		try {
			const parsed = parseCustomCommandFile(
				await readUtf8File(candidate.filePath)
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
	input: ConfigRuntime
): Promise<CustomCommandSpec[]> {
	const snapshot = await input.configStore.getSnapshot(input.workspace);
	return loadCustomCommands(
		discoverCustomCommandCandidates({
			homeRoot: input.homeRoot,
			snapshot,
			workspace: input.workspace,
		})
	);
}

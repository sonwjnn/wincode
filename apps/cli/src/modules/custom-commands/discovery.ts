import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { resolveConfigRelativePath } from "@/shared/config/resolve-config-relative-path";
import { getProjectRoots } from "@/shared/paths/project-roots";
import type { CustomCommandCandidate } from "./types";

const COMMANDS_DIR = join(".wincode", "commands");
const MARKDOWN_EXTENSION = ".md";

export type CustomCommandDiscoveryInput = {
	homeRoot: string;
	snapshot: ConfigSnapshot;
	workspace: string;
};

function collect(
	base: string,
	scope: CustomCommandCandidate["scope"]
): CustomCommandCandidate[] {
	if (!(existsSync(base) && statSync(base).isDirectory())) {
		return [];
	}
	return readdirSync(base, { withFileTypes: true })
		.filter(
			(entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION)
		)
		.map((entry) => ({ filePath: join(base, entry.name), scope }));
}

const configuredRoots = (snapshot: ConfigSnapshot) => {
	const commands = snapshot.document.commands;
	if (
		typeof commands !== "object" ||
		commands === null ||
		Array.isArray(commands) ||
		!("paths" in commands) ||
		!Array.isArray(commands.paths)
	) {
		return [];
	}
	return commands.paths.flatMap((configuredPath, index) => {
		if (typeof configuredPath !== "string" || configuredPath.length === 0) {
			return [];
		}
		const resolved = resolveConfigRelativePath(
			snapshot,
			["commands", "paths", String(index)],
			configuredPath
		);
		return resolved === undefined ? [] : [resolved];
	});
};

export function discoverCustomCommandCandidates(
	input: CustomCommandDiscoveryInput
): CustomCommandCandidate[] {
	const configured = configuredRoots(input.snapshot);
	const result = collect(join(input.homeRoot, COMMANDS_DIR), "global");
	for (const root of configured) {
		if (root.scope === "global") {
			result.push(...collect(root.path, root.scope));
		}
	}
	for (const root of getProjectRoots(input.workspace)) {
		result.push(...collect(join(root, COMMANDS_DIR), "project"));
	}
	for (const root of configured) {
		if (root.scope === "project") {
			result.push(...collect(root.path, root.scope));
		}
	}
	return result;
}

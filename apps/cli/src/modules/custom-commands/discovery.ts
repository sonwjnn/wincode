import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CustomCommandCandidate } from "./types";

const COMMANDS_DIR = join(".wincode", "commands");
const MARKDOWN_EXTENSION = ".md";

function gitRoot(start: string): string {
	let current = resolve(start);
	while (true) {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolve(start);
		}
		current = parent;
	}
}

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

export function discoverCustomCommandCandidates(
	cwd = process.cwd(),
	home = homedir()
): CustomCommandCandidate[] {
	const result = [collect(join(home, COMMANDS_DIR), "global")].flat();
	const boundary = gitRoot(cwd);
	const projectRoots: string[] = [];
	let current = resolve(cwd);
	while (true) {
		projectRoots.push(current);
		if (current === boundary) {
			break;
		}
		const parent = dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	for (const root of projectRoots.reverse()) {
		result.push(...collect(join(root, COMMANDS_DIR), "project"));
	}
	return result;
}

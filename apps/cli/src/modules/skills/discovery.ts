import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SkillCandidate } from "./types";

const locations = [
	".agents/skills",
	".claude/skills",
	".opencode/skills",
] as const;

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
	root: string,
	scope: SkillCandidate["scope"]
): SkillCandidate[] {
	return locations.flatMap((location) => {
		const base = join(root, location);
		if (!(existsSync(base) && statSync(base).isDirectory())) {
			return [];
		}
		return readdirSync(base, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() && existsSync(join(base, entry.name, "SKILL.md"))
			)
			.map((entry) => ({
				filePath: join(base, entry.name, "SKILL.md"),
				root,
				scope,
			}));
	});
}

function collectSkillRoot(
	base: string,
	scope: SkillCandidate["scope"]
): SkillCandidate[] {
	if (!(existsSync(base) && statSync(base).isDirectory())) {
		return [];
	}
	return readdirSync(base, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() && existsSync(join(base, entry.name, "SKILL.md"))
		)
		.map((entry) => ({
			filePath: join(base, entry.name, "SKILL.md"),
			root: dirname(dirname(base)),
			scope,
		}));
}

export function discoverSkillCandidates(
	cwd = process.cwd(),
	home = homedir()
): SkillCandidate[] {
	const result = [
		...collect(home, "global"),
		...collectSkillRoot(join(home, ".config", "opencode", "skills"), "global"),
	];
	const boundary = gitRoot(cwd);
	let current = resolve(cwd);
	const projectRoots: string[] = [];
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
		result.push(...collect(root, "project"));
	}
	return result;
}

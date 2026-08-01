import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { parseSkillFile } from "./frontmatter";
import type { Skill, SkillCandidate } from "./types";

export async function loadSkill(candidate: SkillCandidate): Promise<Skill> {
	const parsed = parseSkillFile(await readFile(candidate.filePath, "utf8"));
	if (parsed.frontmatter.name !== basename(dirname(candidate.filePath))) {
		throw new Error("Skill name must match containing directory");
	}
	return {
		...parsed.frontmatter,
		body: parsed.body.trim(),
		filePath: candidate.filePath,
		scope: candidate.scope,
	};
}

export async function loadSkills(
	candidates: SkillCandidate[]
): Promise<Skill[]> {
	const byName = new Map<string, Skill>();
	for (const candidate of candidates) {
		try {
			const skill = await loadSkill(candidate);
			byName.set(skill.name, skill);
		} catch {
			// Discovery is best-effort: invalid or inaccessible skills are ignored.
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

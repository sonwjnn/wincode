import { stat } from "node:fs/promises";
import type { PermissionDecision } from "@/modules/permissions";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { buildSkillCatalog, type SkillCatalog } from "./activation";
import { discoverSkillCandidates } from "./discovery";
import { loadSkill } from "./loader";
import type { Skill, SkillCandidate } from "./types";

export {
	buildSkillCatalog,
	buildSkillToolDefinition,
	createSkillExecution,
	createSkillSnapshot,
	hashSkillBody,
	isSkillToolPart,
	MAX_ACTIVE_SKILLS,
	MAX_SKILL_BODY_LENGTH,
	MAX_SKILL_CATALOG_BYTES,
	MAX_SKILL_DESCRIPTION_LENGTH,
	MAX_SKILL_NAME_LENGTH,
	MAX_SKILL_RESOURCE_PATH_LENGTH,
	MAX_SKILL_RESOURCE_PATHS,
	type SanitizedSkillToolResult,
	type SkillActivationResult,
	type SkillActivationSnapshot,
	type SkillCatalog,
	type SkillCatalogDiagnostic,
	type SkillCatalogEntry,
	type SkillExecution,
	type SkillToolPart,
	type SkillToolResult,
	sampleSkillResources,
	sanitizeSkillToolPart,
	sanitizeSkillToolResult,
} from "./activation";
export { discoverSkillCandidates } from "./discovery";
export { parseSkillFile, SkillValidationError } from "./frontmatter";
export { parseSkillInvocation } from "./invocation";
export { loadSkill, loadSkills } from "./loader";
export type {
	Skill,
	SkillCandidate,
	SkillFrontmatter,
	SkillInvocation,
} from "./types";

type CachedSkillFile = {
	mtimeMs: number;
	size: number;
	skill: Skill;
};

/**
 * Parsed Skill files are cached by path and file metadata so each execution
 * turn pays the filesystem cost once. The cache is consulted through
 * `discoverSkillCatalog` and the explicit-invocation resolver; file changes
 * become visible on the next discovery because the metadata key changes.
 */
const skillFileCache = new Map<string, CachedSkillFile>();

const loadSkillCached = async (candidate: SkillCandidate): Promise<Skill> => {
	const fileStat = await stat(candidate.filePath);
	const cached = skillFileCache.get(candidate.filePath);
	if (
		cached &&
		cached.mtimeMs === fileStat.mtimeMs &&
		cached.size === fileStat.size
	) {
		return cached.skill;
	}
	const skill = await loadSkill(candidate);
	skillFileCache.set(candidate.filePath, {
		mtimeMs: fileStat.mtimeMs,
		size: fileStat.size,
		skill,
	});
	return skill;
};

export async function discoverSkills(input: ConfigRuntime): Promise<Skill[]> {
	const snapshot = await input.configStore.getSnapshot(input.workspace);
	const candidates = discoverSkillCandidates({
		homeRoot: input.homeRoot,
		snapshot,
		workspace: input.workspace,
	});
	const byName = new Map<string, Skill>();
	for (const candidate of candidates) {
		try {
			const skill = await loadSkillCached(candidate);
			byName.set(skill.name, skill);
		} catch {
			// Discovery is best-effort: invalid or inaccessible skills are ignored.
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Builds one permission-filtered catalog snapshot for an execution turn.
 * Skill access defaults to `allow`; the returned catalog hides denied Skills
 * and carries validation diagnostics instead of silently truncating.
 */
export async function discoverSkillCatalog(
	input: ConfigRuntime,
	decideSkill: (name: string) => PermissionDecision
): Promise<SkillCatalog> {
	const skills = await discoverSkills(input);
	return buildSkillCatalog(skills, decideSkill);
}

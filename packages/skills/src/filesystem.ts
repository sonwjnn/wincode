import type { Dirent } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseSkillFile } from "./frontmatter";
import { hashSkillBody } from "./hash";
import type { Skill, SkillScope } from "./types";

export type SkillRootDescriptor = {
	/** Directory whose direct child directories may contain SKILL.md. */
	readonly path: string;
	/** Application scope used by the CLI when applying policy. */
	readonly scope: SkillScope;
	/** Human-readable origin label supplied by the composition root. */
	readonly source: string;
	/** Higher values win when Skills share a name. */
	readonly precedence: number;
};

export type SkillCandidate = {
	readonly filePath: string;
	readonly root: string;
	readonly scope: SkillScope;
	readonly source: string;
	readonly precedence: number;
};

export type LoadedSkill = Skill & {
	readonly baseDirectory: string;
	readonly contentHash: string;
	readonly precedence: number;
	readonly root: string;
	readonly source: string;
};

const compareText = (first: string, second: string): number => {
	if (first < second) {
		return -1;
	}
	if (first > second) {
		return 1;
	}
	return 0;
};

const compareRoots = (
	first: SkillRootDescriptor,
	second: SkillRootDescriptor
): number =>
	first.precedence - second.precedence ||
	compareText(first.source, second.source) ||
	compareText(first.scope, second.scope) ||
	compareText(first.path, second.path);

const compareCandidates = (
	first: SkillCandidate,
	second: SkillCandidate
): number =>
	first.precedence - second.precedence ||
	compareText(first.source, second.source) ||
	compareText(first.scope, second.scope) ||
	compareText(first.root, second.root) ||
	compareText(first.filePath, second.filePath);

const hasSkillFile = (filePath: string): boolean => {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
};

const collectRootCandidates = (root: SkillRootDescriptor): SkillCandidate[] => {
	if (!root.path) {
		return [];
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(root.path, { withFileTypes: true });
	} catch {
		return [];
	}

	const candidates: SkillCandidate[] = [];
	for (const entry of entries.toSorted((first, second) =>
		compareText(first.name, second.name)
	)) {
		if (!entry.isDirectory()) {
			continue;
		}
		const filePath = join(root.path, entry.name, "SKILL.md");
		if (hasSkillFile(filePath)) {
			candidates.push({
				filePath,
				precedence: root.precedence,
				root: root.path,
				scope: root.scope,
				source: root.source,
			});
		}
	}
	return candidates;
};

/**
 * Discovers direct-child SKILL.md files from explicit roots. Root order is
 * never inferred from array order: precedence is explicit and ties are sorted
 * by source, scope, and path for deterministic results.
 */
export function discoverSkillCandidates(
	roots: readonly SkillRootDescriptor[]
): SkillCandidate[] {
	const candidates: SkillCandidate[] = [];
	for (const root of roots.toSorted(compareRoots)) {
		candidates.push(...collectRootCandidates(root));
	}
	return candidates;
}

/**
 * Loads and validates one candidate. Invalid frontmatter, unreadable files,
 * and directory/name mismatches are surfaced to the caller for best-effort
 * discovery handling.
 */
export async function loadSkill(
	candidate: SkillCandidate
): Promise<LoadedSkill> {
	const parsed = parseSkillFile(await readFile(candidate.filePath, "utf8"));
	if (parsed.frontmatter.name !== basename(dirname(candidate.filePath))) {
		throw new Error("Skill name must match containing directory");
	}
	const body = parsed.body.trim();
	return {
		...parsed.frontmatter,
		baseDirectory: dirname(candidate.filePath),
		body,
		contentHash: hashSkillBody(body),
		filePath: candidate.filePath,
		precedence: candidate.precedence,
		root: candidate.root,
		scope: candidate.scope,
		source: candidate.source,
	};
}

/**
 * Loads candidates in explicit precedence order. A later, higher-precedence
 * valid Skill replaces an earlier Skill with the same name; invalid candidates
 * are ignored so one bad file cannot hide a valid lower-precedence entry.
 */
export async function loadSkills(
	candidates: readonly SkillCandidate[]
): Promise<LoadedSkill[]> {
	const byName = new Map<string, LoadedSkill>();
	for (const candidate of candidates.toSorted(compareCandidates)) {
		try {
			const skill = await loadSkill(candidate);
			byName.set(skill.name, skill);
		} catch {
			// Discovery is best-effort: invalid or inaccessible skills are ignored.
		}
	}
	return [...byName.values()].sort((first, second) =>
		first.name.localeCompare(second.name)
	);
}

type CachedSkillFile = {
	mtimeMs: number;
	size: number;
	skill: LoadedSkill;
};

/**
 * Parsed Skill files are cached by path and file metadata. Discovery receives a
 * fresh explicit root snapshot each turn, while edits become visible when file
 * metadata changes or when the root metadata changes.
 */
const skillFileCache = new Map<string, CachedSkillFile>();

const loadSkillCached = async (
	candidate: SkillCandidate
): Promise<LoadedSkill> => {
	const fileStat = await stat(candidate.filePath);
	const cached = skillFileCache.get(candidate.filePath);
	const source = candidate.source;
	const precedence = candidate.precedence;
	if (
		cached &&
		cached.mtimeMs === fileStat.mtimeMs &&
		cached.size === fileStat.size &&
		cached.skill.root === candidate.root &&
		cached.skill.scope === candidate.scope &&
		cached.skill.source === source &&
		cached.skill.precedence === precedence
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

/**
 * Discovers, validates, caches, de-duplicates, and sorts Skills from explicit
 * roots. The filesystem package does not read configuration or infer roots.
 */
export async function discoverSkills(
	roots: readonly SkillRootDescriptor[]
): Promise<LoadedSkill[]> {
	const candidates = await discoverSkillCandidates(roots);
	const byName = new Map<string, LoadedSkill>();
	for (const candidate of candidates) {
		try {
			const skill = await loadSkillCached(candidate);
			byName.set(skill.name, skill);
		} catch {
			// Discovery is best-effort: invalid or inaccessible skills are ignored.
		}
	}
	return [...byName.values()].sort((first, second) =>
		first.name.localeCompare(second.name)
	);
}

/**
 * Returns at most ten deterministic direct resource paths, excluding SKILL.md.
 * Resource contents are not loaded or interpreted by Skill discovery.
 */
export async function sampleSkillResources(
	baseDirectory: string
): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(baseDirectory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.toSorted((first, second) => compareText(first.name, second.name))
		.filter((entry) => entry.name !== "SKILL.md")
		.map((entry) => join(baseDirectory, entry.name))
		.filter((path) => path.length <= 1024)
		.slice(0, 10);
}

export { hashSkillBody } from "./hash";
export type { SkillScope } from "./types";

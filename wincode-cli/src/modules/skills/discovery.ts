import { dirname, join } from "node:path";
import type {
	SkillCandidate,
	SkillRootDescriptor,
} from "@wincode/skills/filesystem";
import { discoverSkillCandidates as discoverFilesystemSkillCandidates } from "@wincode/skills/filesystem";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { resolveConfigRelativePath } from "@/shared/config/resolve-config-relative-path";
import { getProjectRoots } from "@/shared/paths/project-roots";

const LEGACY_LOCATIONS = [
	".agents/skills",
	".claude/skills",
	".opencode/skills",
] as const;
const WINCODE_SKILLS_DIR = join(".wincode", "skills");

const ROOT_SOURCE = {
	configured: "configured",
	legacy: "legacy",
	wincode: "wincode",
} as const;

export type SkillDiscoveryInput = {
	homeRoot: string;
	snapshot: ConfigSnapshot;
	workspace: string;
};

const configuredRoots = (snapshot: ConfigSnapshot) => {
	const skills = snapshot.document.skills;
	if (
		typeof skills !== "object" ||
		skills === null ||
		Array.isArray(skills) ||
		!("paths" in skills) ||
		!Array.isArray(skills.paths)
	) {
		return [];
	}
	return skills.paths.flatMap((configuredPath, index) => {
		if (typeof configuredPath !== "string" || configuredPath.length === 0) {
			return [];
		}
		const resolved = resolveConfigRelativePath(
			snapshot,
			["skills", "paths", String(index)],
			configuredPath
		);
		return resolved === undefined ? [] : [resolved];
	});
};

/**
 * Builds every conventional and configured Skill root in explicit precedence
 * order. Filesystem discovery receives only these descriptors and does not
 * inspect CLI configuration or infer hidden roots.
 */
export function buildSkillRootDescriptors(
	input: SkillDiscoveryInput
): SkillRootDescriptor[] {
	const roots: SkillRootDescriptor[] = [];
	const addRoot = (
		path: string,
		scope: SkillRootDescriptor["scope"],
		source: string
	): void => {
		roots.push({
			path,
			scope,
			source,
			precedence: roots.length,
		});
	};

	for (const location of LEGACY_LOCATIONS) {
		addRoot(join(input.homeRoot, location), "global", ROOT_SOURCE.legacy);
	}
	addRoot(
		join(input.homeRoot, ".config", "opencode", "skills"),
		"global",
		ROOT_SOURCE.legacy
	);
	for (const source of input.snapshot.sources) {
		if (source.scope === "global") {
			addRoot(
				join(dirname(source.path), "skills"),
				"global",
				ROOT_SOURCE.wincode
			);
		}
	}
	for (const root of configuredRoots(input.snapshot)) {
		if (root.scope === "global") {
			addRoot(root.path, root.scope, ROOT_SOURCE.configured);
		}
	}

	for (const projectRoot of getProjectRoots(input.workspace)) {
		for (const location of LEGACY_LOCATIONS) {
			addRoot(join(projectRoot, location), "project", ROOT_SOURCE.legacy);
		}
		addRoot(
			join(projectRoot, WINCODE_SKILLS_DIR),
			"project",
			ROOT_SOURCE.wincode
		);
	}
	for (const root of configuredRoots(input.snapshot)) {
		if (root.scope === "project") {
			addRoot(root.path, root.scope, ROOT_SOURCE.configured);
		}
	}

	return roots;
}

export function discoverSkillCandidates(
	input: SkillDiscoveryInput
): SkillCandidate[] {
	return discoverFilesystemSkillCandidates(buildSkillRootDescriptors(input));
}

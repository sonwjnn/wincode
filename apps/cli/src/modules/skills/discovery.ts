import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { resolveConfigRelativePath } from "@/shared/config/resolve-config-relative-path";
import { getProjectRoots } from "@/shared/paths/project-roots";
import type { SkillCandidate } from "./types";

const locations = [
	".agents/skills",
	".claude/skills",
	".opencode/skills",
] as const;
const WINCODE_SKILLS_DIR = join(".wincode", "skills");

export type SkillDiscoveryInput = {
	homeRoot: string;
	snapshot: ConfigSnapshot;
	workspace: string;
};

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
	scope: SkillCandidate["scope"],
	candidateRoot: string
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
			root: candidateRoot,
			scope,
		}));
}

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

export function discoverSkillCandidates(
	input: SkillDiscoveryInput
): SkillCandidate[] {
	const configured = configuredRoots(input.snapshot);
	const result = [
		...collect(input.homeRoot, "global"),
		...collectSkillRoot(
			join(input.homeRoot, ".config", "opencode", "skills"),
			"global",
			join(input.homeRoot, ".config")
		),
		...input.snapshot.sources.flatMap((source) =>
			source.scope === "global"
				? collectSkillRoot(
						join(dirname(source.path), "skills"),
						source.scope,
						dirname(dirname(source.path))
					)
				: []
		),
	];
	for (const root of configured) {
		if (root.scope === "global") {
			result.push(...collectSkillRoot(root.path, root.scope, root.path));
		}
	}
	for (const root of getProjectRoots(input.workspace)) {
		result.push(...collect(root, "project"));
		result.push(
			...collectSkillRoot(join(root, WINCODE_SKILLS_DIR), "project", root)
		);
	}
	for (const root of configured) {
		if (root.scope === "project") {
			result.push(...collectSkillRoot(root.path, root.scope, root.path));
		}
	}
	return result;
}

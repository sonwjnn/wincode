import * as path from "node:path";
import {
	isArray,
	isNonEmptyString,
	isPlainObject,
	isUndefined,
} from "@wincode/utils";
import { resourceSourcePriority } from "@/modules/application/resource-precedence";
import {
	isTrustedProjectRoot,
	LEGACY_PROJECT_SKILL_ROOTS,
	WINCODE_PROJECT_SKILL_ROOT,
} from "@/modules/project-trust/project-resource-roots";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import { resolveConfigRelativePath } from "@/shared/config/resolve-config-relative-path";
import { getProjectRoots } from "@/shared/paths/project-roots";
import {
	discoverSkillCandidates as discoverFilesystemSkillCandidates,
	type SkillCandidate,
	type SkillRootDescriptor,
} from "./filesystem";

const ROOT_SOURCE = {
	configured: "configured",
	legacy: "legacy",
	wincode: "wincode",
} as const;

export type SkillDiscoveryInput = {
	homeRoot: string;
	snapshot: ConfigSnapshot;
	trustedProjectRoots?: readonly string[];
	workspace: string;
};

const configuredRoots = (snapshot: ConfigSnapshot) => {
	const skills = snapshot.document.skills;
	if (!(isPlainObject(skills) && "paths" in skills && isArray(skills.paths))) {
		return [];
	}
	return skills.paths.flatMap((configuredPath, index) => {
		if (!isNonEmptyString(configuredPath)) {
			return [];
		}
		const resolved = resolveConfigRelativePath(
			snapshot,
			["skills", "paths", String(index)],
			configuredPath
		);
		return isUndefined(resolved) ? [] : [resolved];
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
	const roots: {
		descriptor: Omit<SkillRootDescriptor, "precedence">;
		domainOrder: number;
		sourcePriority: number;
	}[] = [];
	const addRoot = (
		rootPath: string,
		scope: SkillRootDescriptor["scope"],
		source: string
	): void => {
		roots.push({
			descriptor: { path: rootPath, scope, source },
			domainOrder: roots.length,
			sourcePriority: resourceSourcePriority({
				explicit: source === ROOT_SOURCE.configured,
				scope,
			}),
		});
	};

	for (const location of LEGACY_PROJECT_SKILL_ROOTS) {
		addRoot(path.join(input.homeRoot, location), "global", ROOT_SOURCE.legacy);
	}
	addRoot(
		path.join(input.homeRoot, ".config", "opencode", "skills"),
		"global",
		ROOT_SOURCE.legacy
	);
	for (const source of input.snapshot.sources) {
		if (source.scope === "global") {
			addRoot(
				path.join(path.dirname(source.path), "skills"),
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
		if (!isTrustedProjectRoot(projectRoot, input.trustedProjectRoots)) {
			continue;
		}
		for (const location of LEGACY_PROJECT_SKILL_ROOTS) {
			addRoot(path.join(projectRoot, location), "project", ROOT_SOURCE.legacy);
		}
		addRoot(
			path.join(projectRoot, WINCODE_PROJECT_SKILL_ROOT),
			"project",
			ROOT_SOURCE.wincode
		);
	}
	for (const root of configuredRoots(input.snapshot)) {
		if (root.scope === "project") {
			addRoot(root.path, root.scope, ROOT_SOURCE.configured);
		}
	}

	return roots
		.toSorted(
			(first, second) =>
				first.sourcePriority - second.sourcePriority ||
				first.domainOrder - second.domainOrder
		)
		.map(({ descriptor }, precedence) => ({ ...descriptor, precedence }));
}

export function discoverSkillCandidates(
	input: SkillDiscoveryInput
): SkillCandidate[] {
	return discoverFilesystemSkillCandidates(buildSkillRootDescriptors(input));
}

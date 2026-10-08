import * as path from "node:path";
import { canonicalPathSync } from "@/shared/paths/project-roots";

export const LEGACY_PROJECT_SKILL_ROOTS = [
	".agents/skills",
	".claude/skills",
	".opencode/skills",
] as const;
export const WINCODE_PROJECT_SKILL_ROOT = path.join(".wincode", "skills");
export const PROJECT_SKILL_ROOTS = [
	...LEGACY_PROJECT_SKILL_ROOTS,
	WINCODE_PROJECT_SKILL_ROOT,
] as const;
export const PROJECT_COMMAND_ROOT = path.join(".wincode", "commands");

export const isTrustedProjectRoot = (
	projectRoot: string,
	trustedProjectRoots: readonly string[] | undefined
): boolean =>
	trustedProjectRoots === undefined ||
	trustedProjectRoots.includes(canonicalPathSync(projectRoot));

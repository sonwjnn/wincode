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

import type { ConfigRuntime } from "@/shared/config/config-store";
import { discoverSkillCandidates } from "./discovery";
import { loadSkills } from "./loader";

export async function discoverSkills(input: ConfigRuntime) {
	const snapshot = await input.configStore.getSnapshot(input.workspace);
	return loadSkills(
		discoverSkillCandidates({
			homeRoot: input.homeRoot,
			snapshot,
			workspace: input.workspace,
		})
	);
}

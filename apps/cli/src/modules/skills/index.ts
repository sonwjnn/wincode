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

import { discoverSkillCandidates } from "./discovery";
import { loadSkills } from "./loader";

export async function discoverSkills() {
	return loadSkills(discoverSkillCandidates());
}

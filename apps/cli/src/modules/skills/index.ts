import { buildSkillCatalog, type SkillCatalog } from "@wincode/skills";
import type { LoadedSkill } from "@wincode/skills/filesystem";
import { discoverSkills as discoverFilesystemSkills } from "@wincode/skills/filesystem";
import type { PermissionDecision } from "@/modules/permissions";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { buildSkillRootDescriptors } from "./discovery";

export type { SkillDiscoveryInput } from "./discovery";
export {
	buildSkillRootDescriptors,
	discoverSkillCandidates,
} from "./discovery";
export async function discoverSkills(
	input: ConfigRuntime
): Promise<LoadedSkill[]> {
	const snapshot = await input.configStore.getSnapshot(input.workspace);
	return discoverFilesystemSkills(
		buildSkillRootDescriptors({
			homeRoot: input.homeRoot,
			snapshot,
			workspace: input.workspace,
		})
	);
}

/**
 * Builds one permission-filtered Skill catalog for the execution turn. The CLI
 * resolves Tool Permission; the public Skills package only receives its result.
 */
export async function discoverSkillCatalog(
	input: ConfigRuntime,
	decideSkill: (name: string) => PermissionDecision
): Promise<SkillCatalog> {
	const skills = await discoverSkills(input);
	return buildSkillCatalog(skills, decideSkill);
}

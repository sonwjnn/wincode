import type { PermissionDecision } from "@/modules/permissions";
import type { ConfigRuntime } from "@/shared/config/config-store";
import { buildSkillCatalog, type SkillCatalog } from "./activation";
import { buildSkillRootDescriptors } from "./discovery";
import type { LoadedSkill } from "./filesystem";
import { discoverSkills as discoverFilesystemSkills } from "./filesystem";

export * from "./activation";
export * from "./context";
export type { SkillDiscoveryInput } from "./discovery";
export {
	buildSkillRootDescriptors,
	discoverSkillCandidates,
} from "./discovery";
export type {
	LoadedSkill,
	SkillCandidate,
	SkillRootDescriptor,
} from "./filesystem";
export {
	discoverSkillCandidates as discoverFilesystemSkillCandidates,
	discoverSkills as discoverFilesystemSkills,
	hashSkillBody,
	loadSkill,
	loadSkills,
	sampleSkillResources,
} from "./filesystem";
export * from "./frontmatter";
export * from "./invocation";
export * from "./types";

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
 * resolves Tool Permission; the public Skills module only receives its result.
 */
export async function discoverSkillCatalog(
	input: ConfigRuntime,
	decideSkill: (name: string) => PermissionDecision
): Promise<SkillCatalog> {
	const skills = await discoverSkills(input);
	return buildSkillCatalog(skills, decideSkill);
}

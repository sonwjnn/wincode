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
export * from "./search-text";
export * from "./types";

export async function discoverSkills(
	input: ConfigRuntime
): Promise<LoadedSkill[]> {
	const snapshot = await input.configStore.getSnapshot(input.workspace);
	return discoverFilesystemSkills(
		buildSkillRootDescriptors({
			homeRoot: input.homeRoot,
			snapshot,
			trustedProjectRoots: input.trustedProjectRoots,
			workspace: input.workspace,
		})
	);
}

/** Builds the selected Skill catalog for this execution turn. */
export async function discoverSkillCatalog(
	input: ConfigRuntime
): Promise<SkillCatalog> {
	const skills = await discoverSkills(input);
	return buildSkillCatalog(skills);
}

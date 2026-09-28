import type { Skill } from "./types";

export const getSkillSearchText = (
	skill: Pick<Skill, "description" | "name">
): string => `${skill.name} ${skill.description}`;

import type { CustomCommandSpec } from "@/modules/commands/custom/types";
import { SKILL_NAMESPACE_PREFIX, type Skill } from "@/modules/skills";
import { fuzzyMatch } from "@/shared/fuzzy";
import type { CommandSpec } from "./commands";
import type { BaseSpec } from "./types";

/** A discovered Skill offered under the reserved `skill:` namespace. */
export type SkillCommandSpec = BaseSpec & { kind: "skill" };

/** A single slash suggestion that enters the Skill namespace search. */
export type SkillSearchCommandSpec = BaseSpec & { kind: "skill-search" };

export type CommandItem =
	| CommandSpec
	| CustomCommandSpec
	| SkillCommandSpec
	| SkillSearchCommandSpec;

const skillLabel = (name: string): string => `${SKILL_NAMESPACE_PREFIX}${name}`;

/**
 * The row label. Only the leading `/` is dropped: Built-in and Custom Commands
 * show their bare name, Skills keep their namespace so a merged list stays
 * unambiguous.
 */
export const getCommandLabel = (item: CommandItem): string =>
	item.kind === "skill" ? skillLabel(item.name) : item.name;

/** What selecting the row writes into the chat input. */
export const getCommandInvocation = (item: CommandItem): string =>
	`/${getCommandLabel(item)}`;

export const createSkillCommandSpecs = (
	skills: readonly Pick<Skill, "description" | "name">[]
): SkillCommandSpec[] =>
	skills
		.map((skill) => ({
			description: skill.description,
			kind: "skill" as const,
			name: skill.name,
			value: `/${skillLabel(skill.name)}`,
		}))
		.toSorted((left, right) => left.name.localeCompare(right.name));

export const createSkillSearchCommandSpec = (
	skillCount: number
): SkillSearchCommandSpec => ({
	description: `${skillCount} ${skillCount === 1 ? "skill" : "skills"}`,
	kind: "skill-search",
	name: SKILL_NAMESPACE_PREFIX,
	value: `/${SKILL_NAMESPACE_PREFIX}`,
});

/**
 * Commands match by label prefix. Skills fuzzy-match names only,
 * with or without the `skill:` namespace in the query.
 */
const matchesCommandQuery = (item: CommandItem, query: string): boolean => {
	const normalized = query.toLowerCase();
	if (getCommandLabel(item).toLowerCase().startsWith(normalized)) {
		return true;
	}

	if (item.kind !== "skill") {
		return false;
	}

	const skillQuery = normalized.startsWith(SKILL_NAMESPACE_PREFIX)
		? normalized.slice(SKILL_NAMESPACE_PREFIX.length)
		: normalized;
	return fuzzyMatch(skillQuery, item.name).matches;
};

export const filterCommandItems = (
	items: readonly CommandItem[],
	query: string
): CommandItem[] =>
	query.length === 0
		? [...items]
		: items.filter((item) => matchesCommandQuery(item, query));

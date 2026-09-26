import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import { SKILL_NAMESPACE_PREFIX, type Skill } from "@/modules/skills";
import { findSubsequenceMatch } from "@/shared/utils/string-matching";
import type { BaseSpec, CommandSpec } from "./commands";

/** A discovered Skill offered as a row under the reserved `skill:` namespace. */
export type SkillCommandSpec = BaseSpec & { kind: "skill" };

export type CommandItem = CommandSpec | CustomCommandSpec | SkillCommandSpec;

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

/**
 * Commands match by label prefix. Skills also match fuzzy subsequences of their
 * name, with an optional namespace prefix in the query.
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
	return (
		skillQuery.length > 0 &&
		findSubsequenceMatch(item.name.toLowerCase(), skillQuery) !== null
	);
};

export const filterCommandItems = (
	items: readonly CommandItem[],
	query: string
): CommandItem[] =>
	query.length === 0
		? [...items]
		: items.filter((item) => matchesCommandQuery(item, query));

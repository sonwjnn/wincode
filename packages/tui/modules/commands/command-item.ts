import { SKILL_NAMESPACE_PREFIX, type Skill } from "@wincode/skills";
import type { CustomCommandSpec } from "@/modules/custom-commands/types";
import type { BaseSpec, CommandSpec } from "./commands";

/** A discovered Skill offered as a row under the reserved `skill:` namespace. */
export type SkillCommandSpec = BaseSpec & { kind: "skill" };

export type CommandItem = CommandSpec | CustomCommandSpec | SkillCommandSpec;

/**
 * The row label. Only the leading `/` is dropped: Built-in and Custom Commands
 * show their bare name, Skills keep their namespace so a merged list stays
 * unambiguous.
 */
export const getCommandLabel = (item: CommandItem): string =>
	item.kind === "skill" ? `${SKILL_NAMESPACE_PREFIX}${item.name}` : item.name;

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
			value: `/${SKILL_NAMESPACE_PREFIX}${skill.name}`,
		}))
		.toSorted((left, right) => left.name.localeCompare(right.name));

/**
 * Prefix match on the row label, plus the bare name for namespaced rows so
 * typing `foo` still surfaces `skill:foo`.
 */
const matchesCommandQuery = (item: CommandItem, query: string): boolean => {
	const normalized = query.toLowerCase();
	if (getCommandLabel(item).toLowerCase().startsWith(normalized)) {
		return true;
	}
	return (
		item.kind === "skill" && item.name.toLowerCase().startsWith(normalized)
	);
};

export const filterCommandItems = (
	items: readonly CommandItem[],
	query: string
): CommandItem[] =>
	query.length === 0
		? [...items]
		: items.filter((item) => matchesCommandQuery(item, query));

/**
 * Longest visible label, measured over every source so the description column
 * stays aligned while the query narrows the list.
 */
export const getCommandLabelWidth = (items: readonly CommandItem[]): number =>
	items.reduce(
		(width, item) => Math.max(width, getCommandLabel(item).length),
		0
	);

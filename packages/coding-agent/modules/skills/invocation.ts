import type { SkillInvocation } from "./types";

/**
 * The namespace a Skill invocation must carry. Bare `/name` text is never a
 * Skill invocation, so a command list can mix Skills with Built-in and Custom
 * Commands without name collisions.
 */
export const SKILL_NAMESPACE_PREFIX = "skill:";

const INVOCATION_PATTERN = new RegExp(
	`^/${SKILL_NAMESPACE_PREFIX}([a-z0-9][a-z0-9._-]*)(?:\\s+([\\s\\S]*))?$`,
	"iu"
);

/** Whether the input claims the reserved `skill:` namespace, valid or not. */
export const hasSkillNamespace = (input: string): boolean =>
	input.trim().toLowerCase().startsWith(`/${SKILL_NAMESPACE_PREFIX}`);

export function parseSkillInvocation(input: string): SkillInvocation | null {
	const match = input.trim().match(INVOCATION_PATTERN);
	if (!match?.[1]) {
		return null;
	}
	return { name: match[1], arguments: match[2]?.trim() ?? "" };
}

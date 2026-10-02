/**
 * The namespace a Skill invocation must carry. Bare `/name` text is never a
 * Skill invocation, so a command list can mix Skills with Built-in and Custom
 * Commands without name collisions.
 */
export const SKILL_NAMESPACE_PREFIX = "skill:";

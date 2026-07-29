import type { SkillInvocation } from "./types";

const INVOCATION_PATTERN = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i;

export function parseSkillInvocation(input: string): SkillInvocation | null {
	const match = input.trim().match(INVOCATION_PATTERN);
	if (!match?.[1]) {
		return null;
	}
	return { name: match[1], arguments: match[2]?.trim() ?? "" };
}

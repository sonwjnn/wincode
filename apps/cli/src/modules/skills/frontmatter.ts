import { z } from "zod";
import type { SkillFrontmatter } from "./types";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LINE_PATTERN = /\r?\n/;
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_SCHEMA = z
	.object({
		name: z.string().regex(NAME_PATTERN).min(1).max(64),
		description: z.string().min(1).max(1024),
	})
	.passthrough();
const MAX_BODY_LENGTH = 12_000;

export class SkillValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillValidationError";
	}
}

const scalar = (value: string): string | string[] => {
	const trimmed = value.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
			.filter(Boolean);
	}
	return trimmed.replace(/^['"]|['"]$/g, "");
};

export function parseSkillFile(source: string): {
	frontmatter: SkillFrontmatter;
	body: string;
} {
	if (!source.startsWith("---")) {
		throw new SkillValidationError("SKILL.md must start with YAML frontmatter");
	}
	const match = source.match(FRONTMATTER_PATTERN);
	if (!match) {
		throw new SkillValidationError(
			"SKILL.md has invalid YAML frontmatter delimiters"
		);
	}
	const values: Record<string, string | string[]> = {};
	const yaml = match[1];
	if (yaml === undefined) {
		throw new SkillValidationError("SKILL.md has empty frontmatter");
	}
	for (const line of yaml.split(LINE_PATTERN)) {
		if (!line.trim() || line.trim().startsWith("#")) {
			continue;
		}
		const separator = line.indexOf(":");
		if (separator < 1) {
			throw new SkillValidationError(`Invalid frontmatter line: ${line}`);
		}
		values[line.slice(0, separator).trim()] = scalar(line.slice(separator + 1));
	}
	const validated = FRONTMATTER_SCHEMA.safeParse(values);
	if (!validated.success) {
		throw new SkillValidationError("Invalid SKILL.md frontmatter");
	}
	const body = source.slice(match[0].length);
	if (body.length > MAX_BODY_LENGTH) {
		throw new SkillValidationError("SKILL.md body exceeds 12000 characters");
	}
	return {
		frontmatter: validated.data as SkillFrontmatter,
		body,
	};
}

import { z } from "zod";

export const skillContextSchema = z
	.object({
		name: z.string().trim().min(1).max(100),
		instructions: z.string().max(12_000),
		arguments: z.string().max(4000),
	})
	.strict();
export type SkillContext = z.infer<typeof skillContextSchema>;
export const formatSkillUserContext = (skill: SkillContext): string =>
	`<untrusted-skill-context name="${skill.name}">\n${skill.instructions}\n<arguments>${skill.arguments}</arguments>\n</untrusted-skill-context>`;

import { z } from "zod";

export const SKILL_ACTIVATION_SOURCES = ["explicit", "agent"] as const;
export type SkillActivationSource = (typeof SKILL_ACTIVATION_SOURCES)[number];

export const skillContextSchema = z
	.object({
		name: z.string().trim().min(1).max(100),
		instructions: z.string().max(12_000),
		arguments: z.string().max(4000),
	})
	.strict();
export type SkillContext = z.infer<typeof skillContextSchema>;

export const skillActivationSourceSchema = z.enum(SKILL_ACTIVATION_SOURCES);

/**
 * The Skill payload the CLI sends with a chat request so the model loop can
 * wrap the body into the current user turn. Unlike the persisted activation
 * metadata it carries the full instructions; the hosted server forwards it
 * verbatim and never resolves or persists it.
 */
export const skillRequestContextSchema = skillContextSchema.extend({
	contentHash: z.string().min(1),
	source: skillActivationSourceSchema,
});
export type SkillRequestContext = z.infer<typeof skillRequestContextSchema>;

/**
 * The sanitized activation metadata persisted for one Skill selection. It is
 * deliberately free of the Skill body, explicit arguments are optional, and it
 * is the only Skill shape written to durable history. The live model loop
 * receives the body separately through the user-turn or tool-result wrapper.
 */
export const skillActivationSchema = z
	.object({
		name: z.string().trim().min(1).max(100),
		contentHash: z.string().min(1),
		source: skillActivationSourceSchema,
		arguments: z.string().max(4000).optional(),
	})
	.strict();
export type SkillActivation = z.infer<typeof skillActivationSchema>;

export const formatSkillUserContext = (skill: SkillRequestContext): string =>
	`<untrusted-skill-context name="${skill.name}" source="${skill.source}" content-hash="${skill.contentHash}">\n${skill.instructions}\n<arguments>${skill.arguments}</arguments>\n</untrusted-skill-context>`;

/**
 * The single model-supplied input of the native `skill` tool: the exact name of
 * a Skill from the permission-filtered catalog. The tool never accepts
 * arguments; explicit `/skill-name arguments` remains the only argument path.
 */
export const skillToolInputSchema = z
	.object({ name: z.string().trim().min(1) })
	.strict();

export const SKILL_TOOL_INPUT_JSON_SCHEMA: {
	additionalProperties: false;
	properties: { name: { type: "string" } };
	required: ["name"];
	type: "object";
} = {
	additionalProperties: false,
	properties: { name: { type: "string" } },
	required: ["name"],
	type: "object",
};

/**
 * The dynamic tool definition the CLI sends to the model loop so the Agent can
 * activate Skills. The description carries the permission-filtered catalog and
 * is built locally; the hosted server only forwards it as an opaque tool.
 */
export const skillToolDefinitionSchema = z
	.object({
		name: z.literal("skill"),
		description: z.string().min(1).max(24_576),
		inputSchema: z.object({
			additionalProperties: z.literal(false),
			properties: z.object({
				name: z.object({ type: z.literal("string") }),
			}),
			required: z.tuple([z.literal("name")]),
			type: z.literal("object"),
		}),
	})
	.strict();
export type SkillToolDefinition = z.infer<typeof skillToolDefinitionSchema>;

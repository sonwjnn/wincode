import { z } from "zod";
import type { SkillRequestContext, SkillToolDefinition } from "./types";
import { SKILL_ACTIVATION_SOURCES } from "./types";

export type {
	SkillActivation,
	SkillActivationSource,
	SkillContext,
	SkillRequestContext,
	SkillToolDefinition,
} from "./types";

export const skillContextSchema = z
	.object({
		name: z.string().trim().min(1).max(100),
		instructions: z.string().max(12_000),
		arguments: z.string().max(4000),
	})
	.strict();

export const skillActivationSourceSchema = z.enum(SKILL_ACTIVATION_SOURCES);

/**
 * The Skill payload the model loop uses to wrap the body into the current user
 * turn. Persisted activation metadata never contains the body.
 */
export const skillRequestContextSchema = skillContextSchema.extend({
	contentHash: z.string().min(1),
	source: skillActivationSourceSchema,
});

/**
 * Sanitized activation metadata persisted for one Skill selection. It is free
 * of the Skill body and is the only Skill shape written to durable history.
 */
export const skillActivationSchema = z
	.object({
		name: z.string().trim().min(1).max(100),
		contentHash: z.string().min(1),
		source: skillActivationSourceSchema,
		arguments: z.string().max(4000).optional(),
	})
	.strict();

/**
 * The single model-supplied input of the native `skill` tool: the exact name
 * of a Skill from the permission-filtered catalog. Explicit invocation remains
 * the only argument path.
 */
export const skillToolInputSchema = z
	.object({ name: z.string().trim().min(1) })
	.strict();

export const SKILL_TOOL_INPUT_JSON_SCHEMA: SkillToolDefinition["inputSchema"] =
	{
		additionalProperties: false,
		properties: { name: { type: "string" } },
		required: ["name"],
		type: "object",
	};

/**
 * The dynamic tool definition whose description carries the permitted catalog.
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

export const formatSkillUserContext = (skill: SkillRequestContext): string =>
	`<untrusted-skill-context name="${skill.name}" source="${skill.source}" content-hash="${skill.contentHash}">\n${skill.instructions}\n<arguments>${skill.arguments}</arguments>\n</untrusted-skill-context>`;

import { z } from "zod";
import { agentIdSchema } from "./agents";
import {
	findSupportedChatModelSelection,
	getSupportedModelVariants,
	modelSelectionSchema,
	modelVariantSchema,
	normalizeChatModelSelection,
} from "./models";
import {
	skillActivationSchema,
	skillActivationSourceSchema,
	skillContextSchema,
} from "./skill-context";

/**
 * The Skill shape attached to message metadata. It is a union of:
 * - the sanitized activation metadata (persisted rows and explicit activation),
 * - the full snapshot carried in memory (and by legacy persisted rows) so the
 *   transport can wrap the body into the current user turn.
 */
export const codingMessageSkillSchema = z.union([
	skillActivationSchema,
	skillContextSchema.extend({
		contentHash: z.string().min(1),
		source: skillActivationSourceSchema.optional(),
	}),
]);
export type CodingMessageSkill = z.infer<typeof codingMessageSkillSchema>;

const legacyChatModelSelectionSchema = z
	.string()
	.transform((selection, ctx) => {
		const normalized = normalizeChatModelSelection(selection);
		if (!normalized) {
			ctx.addIssue({
				code: "custom",
				message: "Unsupported legacy model selection",
			});
			return z.NEVER;
		}
		return normalized;
	});

const codingMessageModelSchema = z.union([
	modelSelectionSchema,
	legacyChatModelSelectionSchema,
]);

export const codingMessageUsageSchema = z
	.object({
		cacheReadTokens: z.number().int().nonnegative().optional(),
		cacheWriteTokens: z.number().int().nonnegative().optional(),
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		reasoningTokens: z.number().int().nonnegative().optional(),
		totalTokens: z.number().int().nonnegative().optional(),
	})
	.strict();

export type CodingMessageUsage = z.infer<typeof codingMessageUsageSchema>;

export const codingMessageMetadataSchema = z
	.object({
		interrupted: z.boolean().optional(),
		skill: codingMessageSkillSchema.optional(),
		agent: agentIdSchema.optional(),
		model: codingMessageModelSchema.optional(),
		responseTimeMs: z.number().int().nonnegative().optional(),
		usage: codingMessageUsageSchema.optional(),
		variant: modelVariantSchema.optional(),
	})
	.strict()
	.superRefine((metadata, ctx) => {
		if (metadata.model === undefined) {
			return;
		}

		const supportedSelection = findSupportedChatModelSelection(metadata.model);
		if (!supportedSelection) {
			ctx.addIssue({ code: "custom", message: "Unsupported model selection" });
			return;
		}

		if (metadata.variant === undefined) {
			return;
		}

		if (!getSupportedModelVariants(metadata.model).includes(metadata.variant)) {
			ctx.addIssue({
				code: "custom",
				message: "Variant is not supported for selected model",
			});
		}
	});

export type CodingMessageMetadata = z.infer<typeof codingMessageMetadataSchema>;

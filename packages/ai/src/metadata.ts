import { z } from "zod";
import { agentIdSchema } from "./agents";
import {
	chatModelSelectionSchema,
	findSupportedChatModelSelection,
	getSupportedModelVariants,
	modelVariantSchema,
	normalizeChatModelSelection,
} from "./models";
import { codingModeNameSchema } from "./modes";
import { skillContextSchema } from "./skill-context";

export const codingMessageSkillSchema = skillContextSchema.extend({
	contentHash: z.string().min(1),
});
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
	chatModelSelectionSchema,
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
		mode: codingModeNameSchema.optional(),
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
	})
	.transform((metadata) =>
		metadata.agent === undefined && metadata.mode !== undefined
			? { ...metadata, agent: metadata.mode }
			: metadata
	);

export type CodingMessageMetadata = z.infer<typeof codingMessageMetadataSchema>;

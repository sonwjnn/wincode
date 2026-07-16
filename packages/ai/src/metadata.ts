import { z } from "zod";
import {
	chatModelSelectionSchema,
	findSupportedChatModelSelection,
	getSupportedModelVariants,
	modelVariantSchema,
	normalizeChatModelSelection,
} from "./models";
import { codingModeNameSchema } from "./modes";

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

export const codingMessageMetadataSchema = z
	.object({
		interrupted: z.boolean().optional(),
		mode: codingModeNameSchema.optional(),
		model: codingMessageModelSchema.optional(),
		responseTimeMs: z.number().int().nonnegative().optional(),
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

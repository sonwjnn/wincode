import { z } from "zod";
import type { EditMode } from "../../versioned/contracts";
import { fileVersionSchema, lineRangeSchema } from "../../versioned/model";

const editDiffSchema = z.object({
	additions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
	omittedHunks: z.number().int().nonnegative(),
	patch: z.string(),
	truncated: z.boolean(),
});

const hashlineEditSchema = z
	.object({
		mode: z.literal("hashline").optional(),
		patch: z.string().min(1),
	})
	.strict();

const replaceEditSchema = z
	.object({
		mode: z.literal("replace"),
		newString: z.string(),
		oldString: z.string().min(1),
		path: z.string().min(1),
		replaceAll: z.boolean().optional(),
	})
	.strict();

const sloppyEditSchema = z
	.object({
		mode: z.literal("sloppy"),
		patch: z.string().min(1),
	})
	.strict();

export const editInputSchema = z.union([
	hashlineEditSchema,
	replaceEditSchema,
	sloppyEditSchema,
]);
export const editInputSchemaForMode = (mode: EditMode) => {
	switch (mode) {
		case "hashline":
			return hashlineEditSchema;
		case "replace":
			return replaceEditSchema;
		case "sloppy":
			return sloppyEditSchema;
		default:
			throw new Error(`Unsupported Edit Mode: ${mode}`);
	}
};

export const editOutputSchema = z
	.object({
		editDiff: editDiffSchema.optional(),
		newFileVersion: fileVersionSchema,
		observationId: z.string().min(1).optional(),
		oldFileVersion: fileVersionSchema.optional(),
		path: z.string(),
		replacements: z.number().int().min(1),
		seenLines: z.array(lineRangeSchema).optional(),
	})
	.strict();

export const editToolSchema = {
	description:
		"Edit one existing UTF-8 text file. Hashline is the verified default and accepts one versioned line-range patch. Replace requires one exact live-text match. Sloppy is weaker, one-file context matching and is separately permissioned.",
	name: "edit",
	schema: editInputSchema,
} as const;

export type EditInput = z.infer<typeof editInputSchema>;
export type EditOutput = z.infer<typeof editOutputSchema>;
export type EditDiff = z.infer<typeof editDiffSchema>;

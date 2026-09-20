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

const patchEditSchema = z
	.object({
		mode: z.literal("patch"),
		patch: z.string().min(1),
	})
	.strict();

const applyPatchEditSchema = z
	.object({
		mode: z.literal("apply_patch"),
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
	patchEditSchema,
	applyPatchEditSchema,
	replaceEditSchema,
	sloppyEditSchema,
]);
export const editInputSchemaForMode = (mode: EditMode) => {
	switch (mode) {
		case "hashline":
			return hashlineEditSchema;
		case "patch":
			return patchEditSchema;
		case "apply_patch":
			return applyPatchEditSchema;
		case "replace":
			return replaceEditSchema;
		case "sloppy":
			return sloppyEditSchema;
		default:
			throw new Error(`Unsupported Edit Mode: ${mode}`);
	}
};

const editFileResultSchema = z
	.object({
		editDiff: editDiffSchema.optional(),
		fullDiffArtifact: z
			.object({
				byteLength: z.number().int().nonnegative(),
				id: z.string().min(1),
			})
			.strict()
			.optional(),
		hunkCount: z.number().int().positive(),
		newFileVersion: fileVersionSchema,
		oldFileVersion: fileVersionSchema,
		path: z.string(),
		status: z.literal("committed"),
	})
	.strict();

export const editOutputSchema = z
	.object({
		editDiff: editDiffSchema.optional(),
		files: z.array(editFileResultSchema).min(1).optional(),
		fullDiffArtifact: z
			.object({
				byteLength: z.number().int().nonnegative(),
				id: z.string().min(1),
			})
			.strict()
			.optional(),
		newFileVersion: fileVersionSchema.optional(),
		observationId: z.string().min(1).optional(),
		oldFileVersion: fileVersionSchema.optional(),
		path: z.string().optional(),
		replacements: z.number().int().positive().optional(),
		seenLines: z.array(lineRangeSchema).optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.files !== undefined ||
			(value.path !== undefined && value.newFileVersion !== undefined),
		"Edit output must include a committed file result."
	);

export const editToolSchema = {
	description:
		"Edit existing UTF-8 text files with verified File Versions. Hashline accepts one hunk, patch accepts multiple hunks for one file, and apply_patch accepts multiple sections across files. Replace requires one exact live-text match. Sloppy is weaker, one-file context matching and is separately permissioned.",
	name: "edit",
	schema: editInputSchema,
} as const;

export type EditInput = z.infer<typeof editInputSchema>;
export type EditOutput = z.infer<typeof editOutputSchema>;
export type EditDiff = z.infer<typeof editDiffSchema>;

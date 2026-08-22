import { z } from "zod";

const editDiffSchema = z.object({
	additions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
	omittedHunks: z.number().int().nonnegative(),
	patch: z.string(),
	truncated: z.boolean(),
});

export const editInputSchema = z
	.object({
		find: z.string().min(1),
		path: z.string().min(1),
		replace: z.string(),
		replaceAll: z.boolean().optional(),
	})
	.refine(({ find, replace }) => find !== replace, {
		message: "find and replace must differ",
		path: ["replace"],
	});

export const editOutputSchema = z.object({
	editDiff: editDiffSchema.optional(),
	path: z.string(),
	replacements: z.number().int().min(0),
});

export const editToolSchema = {
	description:
		"Edit a UTF-8 file by replacing a small exact unique substring with different content.",
	name: "edit",
	schema: editInputSchema,
} as const;

export type EditInput = z.infer<typeof editInputSchema>;
export type EditOutput = z.infer<typeof editOutputSchema>;
export type EditDiff = z.infer<typeof editDiffSchema>;

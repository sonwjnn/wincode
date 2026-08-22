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
		content: z.string().optional(),
		find: z.string().min(1).optional(),
		path: z.string().min(1),
		replace: z.string().optional(),
		replaceAll: z.boolean().optional(),
	})
	.superRefine((input, context) => {
		const hasContent = input.content !== undefined;
		const hasExactFields =
			input.find !== undefined ||
			input.replace !== undefined ||
			input.replaceAll !== undefined;
		if (hasContent === hasExactFields) {
			context.addIssue({
				code: "custom",
				message: "provide either content or find and replace",
			});
			return;
		}
		if (
			hasExactFields &&
			(input.find === undefined || input.replace === undefined)
		) {
			context.addIssue({
				code: "custom",
				message: "find and replace are both required",
			});
			return;
		}
		if (input.find !== undefined && input.find === input.replace) {
			context.addIssue({
				code: "custom",
				message: "find and replace must differ",
				path: ["replace"],
			});
		}
	});

export const editOutputSchema = z.object({
	editDiff: editDiffSchema.optional(),
	path: z.string(),
	replacements: z.number().int().min(0),
});

export const editToolSchema = {
	description:
		"Modify an existing UTF-8 file. Use content for the whole file, or find and replace for one exact change.",
	name: "edit",
	schema: editInputSchema,
} as const;

export type EditInput = z.infer<typeof editInputSchema>;
export type EditOutput = z.infer<typeof editOutputSchema>;
export type EditDiff = z.infer<typeof editDiffSchema>;

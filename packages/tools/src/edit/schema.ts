import { z } from "zod";

export const editInputSchema = z.object({
	find: z.string().min(1),
	path: z.string().min(1),
	replace: z.string(),
	replaceAll: z.boolean().optional(),
});

export const editOutputSchema = z.object({
	path: z.string(),
	replacements: z.number().int().min(0),
});

export const editToolSchema = {
	description:
		"Edit a UTF-8 text file inside the workspace by replacing an exact string.",
	name: "edit",
	schema: editInputSchema,
} as const;

export type EditInput = z.infer<typeof editInputSchema>;
export type EditOutput = z.infer<typeof editOutputSchema>;

import { z } from "zod";

export const grepInputSchema = z.object({
	flags: z.string().optional(),
	path: z.string().min(1).optional(),
	pattern: z.string().min(1),
});

export const grepOutputSchema = z.object({
	matches: z.array(
		z.object({
			line: z.string(),
			lineNumber: z.number().int().min(1),
			path: z.string(),
		})
	),
});

export const grepToolSchema = {
	description:
		"Search text files inside the workspace with a JavaScript regular expression.",
	name: "grep",
	schema: grepInputSchema,
} as const;

export type GrepInput = z.infer<typeof grepInputSchema>;
export type GrepOutput = z.infer<typeof grepOutputSchema>;

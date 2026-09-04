import { z } from "zod";

export const grepInputSchema = z.object({
	path: z.string().min(1).optional(),
	pattern: z.string().min(1),
});

export const grepOutputSchema = z.object({
	truncated: z.boolean().optional(),
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
		"Search text files inside the workspace with a regular expression. Use this tool when you need to locate symbols or text. Do not pass shell or ripgrep flags; line numbers are included in the results.",
	name: "grep",
	schema: grepInputSchema,
} as const;

export type GrepInput = z.infer<typeof grepInputSchema>;
export type GrepOutput = z.infer<typeof grepOutputSchema>;

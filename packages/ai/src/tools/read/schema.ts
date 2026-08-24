import { z } from "zod";

export const readInputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe("Preserve a leading ~; the local CLI expands the user's home."),
});

export const readOutputSchema = z.object({
	content: z.string(),
	path: z.string(),
	truncated: z.boolean().optional(),
});

export const readToolSchema = {
	description:
		"Read a UTF-8 text file. Preserve ~ paths; never guess an absolute home.",
	name: "read",
	schema: readInputSchema,
} as const;

export type ReadInput = z.infer<typeof readInputSchema>;
export type ReadOutput = z.infer<typeof readOutputSchema>;

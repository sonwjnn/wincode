import { z } from "zod";

export const readInputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			"File path, optionally suffixed by a 1-indexed line selector: :N, :N-M, :N+K, :N-, or comma-separated ranges. L prefixes and .. ranges are accepted. Preserve a leading ~."
		),
});

export const readOutputSchema = z.object({
	content: z.string(),
	path: z.string(),
	truncated: z.boolean().optional(),
});

export const readToolSchema = {
	description:
		"Read a UTF-8 text file with numbered lines. A path may select inclusive line ranges with :N, :N-M, :N+K, :N-, or comma-separated ranges; existing literal paths take precedence. Preserve ~ paths; never guess an absolute home.",
	name: "read",
	schema: readInputSchema,
} as const;

export type ReadInput = z.infer<typeof readInputSchema>;
export type ReadOutput = z.infer<typeof readOutputSchema>;

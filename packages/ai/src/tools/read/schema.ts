import { z } from "zod";

export const readInputSchema = z.object({
	path: z
		.string()
		.min(1)
		.describe(
			"File or directory path, optionally suffixed by a 1-indexed line selector: :N, :N-M, :N+K, :N-, or comma-separated ranges. File selectors address numbered lines; directory selectors address rendered entry positions and omission notices do not consume positions. L prefixes and .. ranges are accepted. Preserve a leading ~."
		),
});

export const readOutputSchema = z.object({
	content: z.string(),
	path: z.string(),
	truncated: z.boolean().optional(),
});

export const readToolSchema = {
	description:
		"Read a UTF-8 text file with numbered lines, or an existing directory as a compact two-level tree (directories first, twelve children max, omissions reported). Selectors :N, :N-M, :N+K, :N-, or comma-separated ranges address file lines or directory entries; omission notices do not consume positions. Existing literal paths take precedence. Preserve ~ paths.",
	name: "read",
	schema: readInputSchema,
} as const;

export type ReadInput = z.infer<typeof readInputSchema>;
export type ReadOutput = z.infer<typeof readOutputSchema>;

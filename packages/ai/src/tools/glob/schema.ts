import { z } from "zod";

export const GLOB_DEFAULT_LIMIT = 200;
export const GLOB_MAX_LIMIT = 200;

export const globInputSchema = z.object({
	gitignore: z.boolean().optional(),
	hidden: z.boolean().optional(),
	limit: z.number().int().min(1).max(GLOB_MAX_LIMIT).optional(),
	path: z.string().min(1).optional(),
	pattern: z.string().min(1),
});

export const globOutputSchema = z.object({
	truncated: z.boolean().optional(),
	paths: z.array(z.string()),
});

export const globToolSchema = {
	description:
		"Find workspace files by glob pattern. Results are workspace-relative paths, exclude directories, hidden files are omitted by default, and .git is always excluded. Use path, hidden, gitignore, and limit to narrow discovery; if results are truncated, narrow the path or pattern and try again.",
	name: "glob",
	schema: globInputSchema,
} as const;

export type GlobInput = z.infer<typeof globInputSchema>;
export type GlobOutput = z.infer<typeof globOutputSchema>;

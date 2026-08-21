import { z } from "zod";

export const writeInputSchema = z.object({
	content: z.string(),
	path: z.string().min(1),
});

export const writeOutputSchema = z.object({
	bytesWritten: z.number().int().min(0),
	path: z.string(),
});

export const writeToolSchema = {
	description:
		"Create a new UTF-8 text file inside the workspace. This tool refuses to overwrite an existing file; use edit to modify existing files. Parent directories are created inside the workspace.",
	name: "write",
	schema: writeInputSchema,
} as const;

export type WriteInput = z.infer<typeof writeInputSchema>;
export type WriteOutput = z.infer<typeof writeOutputSchema>;

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
		"Create or completely rewrite a UTF-8 text file inside the workspace. Existing files are overwritten; prefer edit for targeted changes. Parent directories are created inside the workspace.",
	name: "write",
	schema: writeInputSchema,
} as const;

export type WriteInput = z.infer<typeof writeInputSchema>;
export type WriteOutput = z.infer<typeof writeOutputSchema>;

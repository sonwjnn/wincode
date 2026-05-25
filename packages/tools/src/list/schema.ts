import { z } from "zod";

export const listInputSchema = z.object({
	depth: z.number().int().min(1).max(5).optional(),
	path: z.string().min(1).optional(),
});

export const listOutputSchema = z.object({
	entries: z.array(
		z.object({
			path: z.string(),
			type: z.enum(["file", "directory"]),
		})
	),
});

export const listToolSchema = {
	description: "List files and directories inside the workspace.",
	name: "list",
	schema: listInputSchema,
} as const;

export type ListInput = z.infer<typeof listInputSchema>;
export type ListOutput = z.infer<typeof listOutputSchema>;

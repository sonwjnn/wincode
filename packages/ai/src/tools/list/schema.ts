import { z } from "zod";
import { TOOL_RESOURCE_LIMITS } from "../resource-limits";

export const LIST_DEPTH_MAX = TOOL_RESOURCE_LIMITS.deep.list.maxDepth;

export const listInputSchema = z.object({
	depth: z.number().int().min(1).max(LIST_DEPTH_MAX).optional(),
	path: z.string().min(1).optional(),
});

export const listOutputSchema = z.object({
	truncated: z.boolean().optional(),
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

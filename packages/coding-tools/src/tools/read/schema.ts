import { z } from "zod";
import { fileVersionSchema, lineRangeSchema } from "../../versioned/model";

export const readInputSchema = z
	.object({
		expectedVersion: fileVersionSchema.optional(),
		fullLines: z
			.boolean()
			.optional()
			.describe(
				"Render complete lines, including lines longer than the default display limit."
			),
		path: z
			.string()
			.min(1)
			.describe(
				"File or directory path, optionally suffixed by a 1-indexed line selector: :N, :N-M, :N+K, :N-, or comma-separated ranges."
			),
	})
	.strict();

export const readOutputSchema = z
	.object({
		content: z.string(),
		continuationRanges: z.array(lineRangeSchema).optional(),
		displayedRanges: z.array(lineRangeSchema).optional(),
		fileVersion: fileVersionSchema.optional(),
		observationId: z.string().min(1).optional(),
		path: z.string(),
		seenLines: z.array(lineRangeSchema).optional(),
		snapshotAvailable: z.boolean().optional(),
		truncated: z.boolean().optional(),
	})
	.strict();
export const readToolSchema = {
	description:
		"Read a UTF-8 text file with numbered lines, or an existing directory as a compact two-level tree. Every successful text read returns a content-derived File Version and records only complete displayed lines as Seen Lines. Continuation reads for an already observed text file must include the current File Version; when output is capped, continue with the typed continuationRanges using that same File Version. Use fullLines when long lines must be observed for editing.",
	schema: readInputSchema,
} as const;

export type ReadInput = z.infer<typeof readInputSchema>;
export type ReadOutput = z.infer<typeof readOutputSchema>;

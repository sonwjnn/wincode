import { z } from "zod";
import { fileVersionSchema, lineRangeSchema } from "../versioned/model";

export const writeInputSchema = z
	.object({
		content: z.string(),
		expectedVersion: fileVersionSchema
			.nullable()
			.describe(
				"Set this field to null when creating a new file. For an existing file, supply the exact current File Version returned by Read; never guess or use a placeholder."
			),
		path: z.string().min(1),
	})
	.strict();

export const writeOutputSchema = z
	.object({
		bytesWritten: z.number().int().min(0),
		newFileVersion: fileVersionSchema,
		observationId: z.string().min(1).optional(),
		oldFileVersion: fileVersionSchema.optional(),
		path: z.string(),
		seenLines: z.array(lineRangeSchema).optional(),
	})
	.strict();

export const writeToolSchema = {
	description:
		"Create a new UTF-8 text file with expectedVersion set to null. To overwrite an existing file, use the exact File Version returned by Read; never guess or use a placeholder. Missing parent directories are created and newly created empty parents are removed if the write fails.",
	name: "write",
	schema: writeInputSchema,
} as const;

export type WriteInput = z.infer<typeof writeInputSchema>;
export type WriteOutput = z.infer<typeof writeOutputSchema>;

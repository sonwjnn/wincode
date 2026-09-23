import { z } from "zod";
import { fileVersionSchema, lineRangeSchema } from "../versioned/model";

export const writeInputSchema = z
	.object({
		content: z.string(),
		expectedVersion: fileVersionSchema.optional(),
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
		"Create a UTF-8 text file or overwrite an existing file only with its expected File Version. Missing parent directories are created and newly created empty parents are removed if the write fails.",
	name: "write",
	schema: writeInputSchema,
} as const;

export type WriteInput = z.infer<typeof writeInputSchema>;
export type WriteOutput = z.infer<typeof writeOutputSchema>;

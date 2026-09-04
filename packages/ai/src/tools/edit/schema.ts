import { z } from "zod";

const editDiffSchema = z.object({
	additions: z.number().int().nonnegative(),
	deletions: z.number().int().nonnegative(),
	omittedHunks: z.number().int().nonnegative(),
	patch: z.string(),
	truncated: z.boolean(),
});

export const editInputSchema = z.union([
	z
		.object({
			content: z.string(),
			path: z.string().min(1),
		})
		.strict(),
	z
		.object({
			find: z.string().min(1),
			path: z.string().min(1),
			replace: z.string(),
			replaceAll: z.boolean().optional(),
		})
		.strict()
		.refine((input) => input.find !== input.replace, {
			message: "find and replace must differ",
			path: ["replace"],
		}),
	z
		.object({
			content: z.string(),
			insertAfter: z.boolean().optional(),
			lineHashes: z.string().min(1),
			path: z.string().min(1),
		})
		.strict(),
]);

export const editModelInputJsonSchema = {
	oneOf: [
		{
			additionalProperties: false,
			properties: {
				content: { type: "string" },
				path: { minLength: 1, type: "string" },
			},
			required: ["content", "path"],
			type: "object",
		},
		{
			additionalProperties: false,
			properties: {
				find: { minLength: 1, type: "string" },
				path: { minLength: 1, type: "string" },
				replace: { type: "string" },
				replaceAll: { type: "boolean" },
			},
			required: ["find", "path", "replace"],
			type: "object",
		},
		{
			additionalProperties: false,
			properties: {
				content: { type: "string" },
				insertAfter: { type: "boolean" },
				lineHashes: { minLength: 1, type: "string" },
				path: { minLength: 1, type: "string" },
			},
			required: ["content", "lineHashes", "path"],
			type: "object",
		},
	],
} as const;

export const editOutputSchema = z.object({
	editDiff: editDiffSchema.optional(),
	path: z.string(),
	replacements: z.number().int().min(0),
});

export const editToolSchema = {
	description: "Edit an existing file.",
	name: "edit",
	schema: editInputSchema,
} as const;

export type EditInput = z.infer<typeof editInputSchema>;
export type EditOutput = z.infer<typeof editOutputSchema>;
export type EditDiff = z.infer<typeof editDiffSchema>;

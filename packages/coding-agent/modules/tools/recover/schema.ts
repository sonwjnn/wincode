import { z } from "zod";
import { fileVersionSchema } from "../versioned/model";

export const recoveryActionSchema = z.enum([
	"inspect",
	"restore-original",
	"keep-current",
	"discard",
]);

const expectedVersionsSchema = z.record(
	z.string().min(1),
	fileVersionSchema.nullable()
);

export const recoverInputSchema = z
	.object({
		action: recoveryActionSchema,
		confirm: z.literal(true).optional(),
		expectedVersions: expectedVersionsSchema.optional(),
		recoveryId: z.string().min(1),
	})
	.strict()
	.superRefine((input, context) => {
		if (
			(input.action === "restore-original" ||
				input.action === "keep-current") &&
			input.expectedVersions === undefined
		) {
			context.addIssue({
				code: "custom",
				message: "Recovery mutations require expectedVersions for every path.",
				path: ["expectedVersions"],
			});
		}
		if (input.action === "discard" && input.confirm !== true) {
			context.addIssue({
				code: "custom",
				message: "Destructive recovery discard requires confirm: true.",
				path: ["confirm"],
			});
		}
	});

const recoveryPathSchema = z
	.object({
		canonicalPath: z.string().min(1),
		currentFileVersion: fileVersionSchema.nullable().optional(),
		displayPath: z.string().min(1),
		newFileVersion: fileVersionSchema,
		originalFileVersion: fileVersionSchema.nullable(),
	})
	.strict();

export const recoverOutputSchema = z
	.object({
		action: recoveryActionSchema,
		reconciledBySessionId: z.string().min(1).optional(),
		recoveryId: z.string().min(1),
		status: z.enum(["discarded", "inspected", "resolved"]),
		paths: z.array(recoveryPathSchema),
	})
	.strict();

export const recoverToolSchema = {
	description:
		"Inspect or explicitly reconcile an interrupted file transaction. Inspect is read-only; restore-original and keep-current require the current File Version for every affected path; discard is destructive and requires confirm: true.",
	name: "recover",
	schema: recoverInputSchema,
} as const;

export type RecoverInput = z.infer<typeof recoverInputSchema>;
export type RecoverOutput = z.infer<typeof recoverOutputSchema>;

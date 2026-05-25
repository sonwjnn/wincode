import { z } from "zod";

export const bashInputSchema = z.object({
	command: z.string().min(1),
	timeoutMs: z.number().int().min(1).max(120_000).optional(),
});

export const bashOutputSchema = z.object({
	exitCode: z.number().int(),
	stderr: z.string(),
	stdout: z.string(),
});

export const bashToolSchema = {
	description:
		"Run a bash command with cwd set to the workspace. Bash is not sandboxed and can escape the workspace; use file tools when strict workspace containment is required.",
	name: "bash",
	schema: bashInputSchema,
} as const;

export type BashInput = z.infer<typeof bashInputSchema>;
export type BashOutput = z.infer<typeof bashOutputSchema>;

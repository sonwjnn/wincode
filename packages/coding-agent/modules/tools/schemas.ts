// biome-ignore-all lint/performance/noBarrelFile: Public Zod-only tool schema entry point.
import type { z } from "zod";

export type { EditDiff, EditInput, EditOutput } from "./edit/schema";
export {
	editInputSchema,
	editInputSchemaForMode,
	editOutputSchema,
	editToolSchema,
} from "./edit/schema";
export type { GlobInput, GlobOutput } from "./glob/schema";
export {
	globInputSchema,
	globOutputSchema,
	globToolSchema,
} from "./glob/schema";
export type { GrepInput, GrepOutput } from "./grep/schema";
export {
	grepInputSchema,
	grepOutputSchema,
	grepToolSchema,
} from "./grep/schema";
export type { ReadInput, ReadOutput } from "./read/schema";
export {
	readInputSchema,
	readOutputSchema,
	readToolSchema,
} from "./read/schema";
export type { RecoverInput, RecoverOutput } from "./recover/schema";
export {
	recoverInputSchema,
	recoverOutputSchema,
	recoverToolSchema,
} from "./recover/schema";
export type { ShellInput, ShellOutput, ShellPlatform } from "./shell/schema";
export {
	composeShellToolDescription,
	SHELL_COMMAND_MAX_CHARS,
	SHELL_CWD_MAX_CHARS,
	SHELL_OUTPUT_TAIL_BYTES,
	SHELL_TIMEOUT_DEFAULT_SECONDS,
	SHELL_TIMEOUT_MAX_SECONDS,
	shellInputSchema,
	shellOutputSchema,
	shellPlatformFromNode,
	shellToolDescription,
	shellToolSchema,
} from "./shell/schema";
export type { WriteInput, WriteOutput } from "./write/schema";
export {
	writeInputSchema,
	writeOutputSchema,
	writeToolSchema,
} from "./write/schema";

import { editInputSchema, editOutputSchema } from "./edit/schema";
import { globInputSchema, globOutputSchema } from "./glob/schema";
import { grepInputSchema, grepOutputSchema } from "./grep/schema";
import { readInputSchema, readOutputSchema } from "./read/schema";
import { recoverInputSchema, recoverOutputSchema } from "./recover/schema";
import { shellInputSchema, shellOutputSchema } from "./shell/schema";
import { writeInputSchema, writeOutputSchema } from "./write/schema";

/** Input and output contracts only; descriptions and runners live in the catalog. */
export const codingToolSchemaContracts = {
	read: { inputSchema: readInputSchema, outputSchema: readOutputSchema },
	write: { inputSchema: writeInputSchema, outputSchema: writeOutputSchema },
	edit: { inputSchema: editInputSchema, outputSchema: editOutputSchema },
	recover: {
		inputSchema: recoverInputSchema,
		outputSchema: recoverOutputSchema,
	},
	glob: { inputSchema: globInputSchema, outputSchema: globOutputSchema },
	grep: { inputSchema: grepInputSchema, outputSchema: grepOutputSchema },
	shell: { inputSchema: shellInputSchema, outputSchema: shellOutputSchema },
} as const;

export type CodingToolName = keyof typeof codingToolSchemaContracts;

export type CodingToolInput<Name extends CodingToolName> = z.infer<
	(typeof codingToolSchemaContracts)[Name]["inputSchema"]
>;

export type CodingToolOutput<Name extends CodingToolName> = z.infer<
	(typeof codingToolSchemaContracts)[Name]["outputSchema"]
>;

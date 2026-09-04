// biome-ignore-all lint/performance/noBarrelFile: Public Zod-only tool schema entry point.
import { z } from "zod";

export type { EditDiff, EditInput, EditOutput } from "./edit/schema";
export {
	editInputSchema,
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

import {
	editInputSchema,
	editOutputSchema,
	editToolSchema,
} from "./edit/schema";
import {
	globInputSchema,
	globOutputSchema,
	globToolSchema,
} from "./glob/schema";
import {
	grepInputSchema,
	grepOutputSchema,
	grepToolSchema,
} from "./grep/schema";
import {
	readInputSchema,
	readOutputSchema,
	readToolSchema,
} from "./read/schema";
import {
	composeShellToolDescription,
	shellInputSchema,
	shellOutputSchema,
	shellPlatformFromNode,
	shellToolDescription,
} from "./shell/schema";
import {
	writeInputSchema,
	writeOutputSchema,
	writeToolSchema,
} from "./write/schema";

type CodingToolDefinition<
	InputSchema extends z.ZodType,
	OutputSchema extends z.ZodType,
> = {
	description: string;
	inputSchema: InputSchema;
	outputSchema: OutputSchema;
};

export const codingToolDefinitions = {
	read: {
		description: readToolSchema.description,
		inputSchema: readInputSchema,
		outputSchema: readOutputSchema,
	},
	write: {
		description: writeToolSchema.description,
		inputSchema: writeInputSchema,
		outputSchema: writeOutputSchema,
	},
	edit: {
		description: editToolSchema.description,
		inputSchema: editInputSchema,
		outputSchema: editOutputSchema,
	},
	glob: {
		description: globToolSchema.description,
		inputSchema: globInputSchema,
		outputSchema: globOutputSchema,
	},
	grep: {
		description: grepToolSchema.description,
		inputSchema: grepInputSchema,
		outputSchema: grepOutputSchema,
	},
	shell: {
		description: shellToolDescription,
		inputSchema: shellInputSchema,
		outputSchema: shellOutputSchema,
	},
} satisfies {
	read: CodingToolDefinition<typeof readInputSchema, typeof readOutputSchema>;
	write: CodingToolDefinition<
		typeof writeInputSchema,
		typeof writeOutputSchema
	>;
	edit: CodingToolDefinition<typeof editInputSchema, typeof editOutputSchema>;
	glob: CodingToolDefinition<typeof globInputSchema, typeof globOutputSchema>;
	grep: CodingToolDefinition<typeof grepInputSchema, typeof grepOutputSchema>;
	shell: CodingToolDefinition<
		typeof shellInputSchema,
		typeof shellOutputSchema
	>;
};

export type CodingToolName = keyof typeof codingToolDefinitions;

export const codingToolNames = [
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"shell",
] as const satisfies readonly CodingToolName[];
export const codingToolNameSchema = z.enum(codingToolNames);

export type CodingToolInput<Name extends CodingToolName> = z.infer<
	(typeof codingToolDefinitions)[Name]["inputSchema"]
>;

export type CodingToolOutput<Name extends CodingToolName> = z.infer<
	(typeof codingToolDefinitions)[Name]["outputSchema"]
>;

export const codingToolSchemas = {
	read: {
		description: codingToolDefinitions.read.description,
		name: "read",
		schema: codingToolDefinitions.read.inputSchema,
	},
	write: {
		description: codingToolDefinitions.write.description,
		name: "write",
		schema: codingToolDefinitions.write.inputSchema,
	},
	edit: {
		description: codingToolDefinitions.edit.description,
		name: "edit",
		schema: codingToolDefinitions.edit.inputSchema,
	},
	glob: {
		description: codingToolDefinitions.glob.description,
		name: "glob",
		schema: codingToolDefinitions.glob.inputSchema,
	},
	grep: {
		description: codingToolDefinitions.grep.description,
		name: "grep",
		schema: codingToolDefinitions.grep.inputSchema,
	},
	shell: {
		description: codingToolDefinitions.shell.description,
		name: "shell",
		schema: codingToolDefinitions.shell.inputSchema,
	},
} satisfies {
	[Name in CodingToolName]: {
		description: string;
		name: Name;
		schema: (typeof codingToolDefinitions)[Name]["inputSchema"];
	};
};

export const codingToolSchemaList = [
	codingToolSchemas.read,
	codingToolSchemas.write,
	codingToolSchemas.edit,
	codingToolSchemas.glob,
	codingToolSchemas.grep,
	codingToolSchemas.shell,
] as const;

export const codingToolDefinitionFor = (
	name: CodingToolName,
	platform = shellPlatformFromNode(process.platform)
): CodingToolDefinition<z.ZodType, z.ZodType> & { name: CodingToolName } => ({
	...codingToolDefinitions[name],
	description:
		name === "shell"
			? composeShellToolDescription(platform)
			: codingToolDefinitions[name].description,
	name,
});

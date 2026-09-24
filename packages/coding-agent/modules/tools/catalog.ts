import type { ToolDefinition } from "@wincode/agent-core";
import { runEditTool } from "./edit/runner";
import { runGlobTool } from "./glob/runner";
import { runGrepTool } from "./grep/runner";
import { runReadTool } from "./read/runner";
import { runRecoverTool } from "./recover/runner";
import type { CodingToolRunnerOptions } from "./runners";
import {
	type CodingToolInput,
	type CodingToolName,
	type CodingToolOutput,
	codingToolSchemaContracts,
	composeShellToolDescription,
	editToolSchema,
	globToolSchema,
	grepToolSchema,
	readToolSchema,
	recoverToolSchema,
	type ShellPlatform,
	shellToolDescription,
	writeToolSchema,
} from "./schemas";
import { runShellTool } from "./shell/runner";
import { runWriteTool } from "./write/runner";

type CodingToolDescriptor<Name extends CodingToolName> = {
	description: string;
	inputSchema: (typeof codingToolSchemaContracts)[Name]["inputSchema"];
	outputSchema: (typeof codingToolSchemaContracts)[Name]["outputSchema"];
	run: (
		input: CodingToolInput<Name>,
		options?: CodingToolRunnerOptions
	) => Promise<CodingToolOutput<Name>>;
	describe?: (platform: ShellPlatform) => string;
};

type CodingToolCatalog = {
	[Name in CodingToolName]: CodingToolDescriptor<Name>;
};

export const codingToolCatalog: CodingToolCatalog = {
	read: {
		...codingToolSchemaContracts.read,
		description: readToolSchema.description,
		run: runReadTool,
	},
	write: {
		...codingToolSchemaContracts.write,
		description: writeToolSchema.description,
		run: runWriteTool,
	},
	edit: {
		...codingToolSchemaContracts.edit,
		description: editToolSchema.description,
		run: runEditTool,
	},
	recover: {
		...codingToolSchemaContracts.recover,
		description: recoverToolSchema.description,
		run: runRecoverTool,
	},
	glob: {
		...codingToolSchemaContracts.glob,
		description: globToolSchema.description,
		run: runGlobTool,
	},
	grep: {
		...codingToolSchemaContracts.grep,
		description: grepToolSchema.description,
		run: runGrepTool,
	},
	shell: {
		...codingToolSchemaContracts.shell,
		description: shellToolDescription,
		describe: composeShellToolDescription,
		run: runShellTool,
	},
};

/** Catalog order is the canonical order for static coding-tool consumers. */
export const codingToolNames: readonly CodingToolName[] = Object.freeze(
	Object.keys(codingToolCatalog) as CodingToolName[]
);

/** Builds a model-facing definition while retaining the catalog's neutral description. */
export const codingToolDefinitionFor = (
	name: CodingToolName,
	platform: ShellPlatform
): ToolDefinition => {
	const descriptor = codingToolCatalog[name];
	return {
		description: descriptor.describe?.(platform) ?? descriptor.description,
		inputSchema: descriptor.inputSchema,
		name,
		outputSchema: descriptor.outputSchema,
	};
};

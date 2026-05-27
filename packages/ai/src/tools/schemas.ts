// biome-ignore-all lint/performance/noBarrelFile: Public Zod-only tool schema entry point.
import type { z } from "zod";

export type { EditInput, EditOutput } from "./edit/schema";
export {
	editInputSchema,
	editOutputSchema,
	editToolSchema,
} from "./edit/schema";
export type { GrepInput, GrepOutput } from "./grep/schema";
export {
	grepInputSchema,
	grepOutputSchema,
	grepToolSchema,
} from "./grep/schema";
export type { ListInput, ListOutput } from "./list/schema";
export {
	listInputSchema,
	listOutputSchema,
	listToolSchema,
} from "./list/schema";
export type { ReadInput, ReadOutput } from "./read/schema";
export {
	readInputSchema,
	readOutputSchema,
	readToolSchema,
} from "./read/schema";
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
	grepInputSchema,
	grepOutputSchema,
	grepToolSchema,
} from "./grep/schema";
import {
	listInputSchema,
	listOutputSchema,
	listToolSchema,
} from "./list/schema";
import {
	readInputSchema,
	readOutputSchema,
	readToolSchema,
} from "./read/schema";
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
	list: {
		description: listToolSchema.description,
		inputSchema: listInputSchema,
		outputSchema: listOutputSchema,
	},
	grep: {
		description: grepToolSchema.description,
		inputSchema: grepInputSchema,
		outputSchema: grepOutputSchema,
	},
} satisfies {
	read: CodingToolDefinition<typeof readInputSchema, typeof readOutputSchema>;
	write: CodingToolDefinition<
		typeof writeInputSchema,
		typeof writeOutputSchema
	>;
	edit: CodingToolDefinition<typeof editInputSchema, typeof editOutputSchema>;
	list: CodingToolDefinition<typeof listInputSchema, typeof listOutputSchema>;
	grep: CodingToolDefinition<typeof grepInputSchema, typeof grepOutputSchema>;
};

export type CodingToolName = keyof typeof codingToolDefinitions;

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
	list: {
		description: codingToolDefinitions.list.description,
		name: "list",
		schema: codingToolDefinitions.list.inputSchema,
	},
	grep: {
		description: codingToolDefinitions.grep.description,
		name: "grep",
		schema: codingToolDefinitions.grep.inputSchema,
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
	codingToolSchemas.list,
	codingToolSchemas.grep,
] as const;

// biome-ignore-all lint/performance/noBarrelFile: Public schema-only package entry point.
export type { BashInput, BashOutput } from "./bash/schema";
export {
	bashInputSchema,
	bashOutputSchema,
	bashToolSchema,
} from "./bash/schema";
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

import { bashToolSchema } from "./bash/schema";
import { editToolSchema } from "./edit/schema";
import { grepToolSchema } from "./grep/schema";
import { listToolSchema } from "./list/schema";
import { readToolSchema } from "./read/schema";
import { writeToolSchema } from "./write/schema";

export const toolSchemas = [
	listToolSchema,
	grepToolSchema,
	readToolSchema,
	writeToolSchema,
	editToolSchema,
	bashToolSchema,
] as const;

export type ToolName = (typeof toolSchemas)[number]["name"];

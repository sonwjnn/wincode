import {
	bashToolSchema,
	editToolSchema,
	grepToolSchema,
	listToolSchema,
	readToolSchema,
	writeToolSchema,
} from "@wincode/tools";
import { tool } from "ai";

export const codingTools = {
	bash: tool({
		description: bashToolSchema.description,
		inputSchema: bashToolSchema.schema,
	}),
	edit: tool({
		description: editToolSchema.description,
		inputSchema: editToolSchema.schema,
	}),
	grep: tool({
		description: grepToolSchema.description,
		inputSchema: grepToolSchema.schema,
	}),
	list: tool({
		description: listToolSchema.description,
		inputSchema: listToolSchema.schema,
	}),
	read: tool({
		description: readToolSchema.description,
		inputSchema: readToolSchema.schema,
	}),
	write: tool({
		description: writeToolSchema.description,
		inputSchema: writeToolSchema.schema,
	}),
};

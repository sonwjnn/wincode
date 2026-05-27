import { type Tool, tool } from "ai";
import {
	type CodingToolInput,
	type CodingToolName,
	type CodingToolOutput,
	codingToolDefinitions,
} from "../tools/schemas";

export type CodingServerToolMap = {
	[Name in CodingToolName]: Tool<CodingToolInput<Name>, CodingToolOutput<Name>>;
};

export const codingServerTools = {
	read: tool({
		description: codingToolDefinitions.read.description,
		inputSchema: codingToolDefinitions.read.inputSchema,
		outputSchema: codingToolDefinitions.read.outputSchema,
	}),
	write: tool({
		description: codingToolDefinitions.write.description,
		inputSchema: codingToolDefinitions.write.inputSchema,
		outputSchema: codingToolDefinitions.write.outputSchema,
	}),
	edit: tool({
		description: codingToolDefinitions.edit.description,
		inputSchema: codingToolDefinitions.edit.inputSchema,
		outputSchema: codingToolDefinitions.edit.outputSchema,
	}),
	list: tool({
		description: codingToolDefinitions.list.description,
		inputSchema: codingToolDefinitions.list.inputSchema,
		outputSchema: codingToolDefinitions.list.outputSchema,
	}),
	grep: tool({
		description: codingToolDefinitions.grep.description,
		inputSchema: codingToolDefinitions.grep.inputSchema,
		outputSchema: codingToolDefinitions.grep.outputSchema,
	}),
} satisfies CodingServerToolMap;

import { jsonSchema, type Tool, tool } from "ai";
import {
	editInputSchema,
	editModelInputJsonSchema,
} from "../tools/edit/schema";
import {
	type CodingToolInput,
	type CodingToolName,
	type CodingToolOutput,
	codingToolDefinitions,
} from "../tools/schemas";
import {
	composeShellToolDescription,
	type ShellInput,
	type ShellOutput,
	type ShellPlatform,
	shellInputSchema,
	shellOutputSchema,
} from "../tools/shell/schema";

/**
 * The server-declared coding tools. `shell` is deliberately absent: the hosted
 * runtime never advertises it, and the CLI composes the platform-specific
 * shell declaration locally through {@link buildShellServerTool}.
 */
export type CodingServerToolName = Exclude<CodingToolName, "shell">;

export type CodingServerToolMap = {
	[Name in CodingServerToolName]: Tool<
		CodingToolInput<Name>,
		CodingToolOutput<Name>
	>;
};

const editServerInputSchema = jsonSchema<CodingToolInput<"edit">>(
	editModelInputJsonSchema,
	{
		validate: (value) => {
			const result = editInputSchema.safeParse(value);
			return result.success
				? { success: true, value: result.data }
				: { error: result.error, success: false };
		},
	}
);

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
		inputSchema: editServerInputSchema,
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

/**
 * The CLI-only `shell` declaration for the local model loop, composed per
 * platform so the system prompt names the active shell syntax. The hosted
 * runtime never receives it.
 */
export const buildShellServerTool = (
	platform: ShellPlatform
): Tool<ShellInput, ShellOutput> =>
	tool({
		description: composeShellToolDescription(platform),
		inputSchema: shellInputSchema,
		outputSchema: shellOutputSchema,
	});

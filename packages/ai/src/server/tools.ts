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
 * The coding tools shared by the local model loop. `shell` is composed by the
 * CLI because its syntax depends on the host platform.
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

export const codingTools = {
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
	glob: tool({
		description: codingToolDefinitions.glob.description,
		inputSchema: codingToolDefinitions.glob.inputSchema,
		outputSchema: codingToolDefinitions.glob.outputSchema,
	}),
	grep: tool({
		description: codingToolDefinitions.grep.description,
		inputSchema: codingToolDefinitions.grep.inputSchema,
		outputSchema: codingToolDefinitions.grep.outputSchema,
	}),
} satisfies CodingServerToolMap;

/**
 * Compose the local `shell` tool for the host platform so the model sees the
 * active shell syntax.
 */
export const buildShellTool = (
	platform: ShellPlatform
): Tool<ShellInput, ShellOutput> =>
	tool({
		description: composeShellToolDescription(platform),
		inputSchema: shellInputSchema,
		outputSchema: shellOutputSchema,
	});

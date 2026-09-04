/**
 * Public coding-tool implementations. The implementation is currently shared
 * with the legacy AI package while callers migrate to this focused boundary.
 */

export {
	codingToolDefinitions,
	codingToolNames,
	codingToolSchemas,
	editInputSchema,
	editOutputSchema,
	writeInputSchema,
	writeOutputSchema,
} from "@wincode/ai";
export type {
	CodingToolInput,
	CodingToolName,
	CodingToolOutput,
	EditDiff,
	EditInput,
	EditOutput,
	GlobInput,
	GlobOutput,
	GrepInput,
	GrepOutput,
	ReadInput,
	ReadOutput,
	ShellInput,
	ShellOutput,
	WriteInput,
	WriteOutput,
} from "@wincode/ai/tools";
export {
	codingToolRunners,
	runEditTool,
	runWriteTool,
} from "@wincode/ai/tools";

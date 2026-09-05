// biome-ignore-all lint/performance/noBarrelFile: Public coding-tools package entry point.

export { isRenderableEditDiff } from "./tools/edit/diff";
export { editModelInputJsonSchema } from "./tools/edit/schema";
export { getReadResourcePath } from "./tools/read/selector";
export type {
	ResourceLimitProfile,
	ToolResourceLimits,
} from "./tools/resource-limits";
export {
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	isElevatedResourceProfile,
	RESOURCE_LIMIT_PERMISSION_ACTION,
	resourceLimitProfileSchema,
} from "./tools/resource-limits";
export {
	codingToolRunners,
	runCodingTool,
	runEditTool,
	runGrepTool,
	runReadTool,
	runShellTool,
	runWriteTool,
} from "./tools/runners";
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
} from "./tools/schemas";
export {
	codingToolDefinitionFor,
	codingToolDefinitions,
	codingToolNames,
	codingToolSchemas,
	composeShellToolDescription,
	editInputSchema,
	editOutputSchema,
	shellPlatformFromNode,
	writeInputSchema,
	writeOutputSchema,
} from "./tools/schemas";
export { SHELL_OUTPUT_TAIL_BYTES } from "./tools/shell/schema";
export type {
	WorkspacePolicy,
	WorkspaceTraversalEntry,
	WorkspaceTraversalOptions,
	WorkspaceTraversalResult,
} from "./workspace";
export {
	createWorkspaceSandbox,
	defaultWorkspaceSandbox,
	isIgnoredWorkspaceDirectory,
	MAX_WORKSPACE_WALK_DEPTH,
	resolveWithinWorkspace,
	resolveWorkspaceRoot,
	traverseWorkspaceEntries,
	WORKSPACE,
	WORKSPACE_IGNORED_DIRECTORY_NAMES,
} from "./workspace";

// biome-ignore-all lint/performance/noBarrelFile: Public coding-tools package entry point.

export { isRenderableEditDiff } from "./tools/edit/diff";
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
	editInputSchemaForMode,
	editOutputSchema,
	shellPlatformFromNode,
	writeInputSchema,
	writeOutputSchema,
} from "./tools/schemas";
export { SHELL_OUTPUT_TAIL_BYTES } from "./tools/shell/schema";
export type {
	CodingToolErrorDetails,
	CodingToolErrorOptions,
	CodingToolRecovery,
	EditMode,
	FileObservation,
	FileObservationStore,
	FileSnapshot,
	VersionedEditingContext,
} from "./versioned/contracts";
export {
	CodingToolError,
	createFileObservation,
	createMemoryFileObservationStore,
	defaultVersionedEditingContext,
	editModeSchema,
	isCodingToolError,
	toCodingToolFailure,
} from "./versioned/contracts";
export type {
	FileVersion,
	LineEnding,
	LineRange,
	LosslessText,
	LosslessTextLine,
} from "./versioned/model";
export {
	byteLength,
	computeFileVersion,
	decodeLosslessText,
	encodeLosslessText,
	FILE_VERSION_ALGORITHM,
	fileVersionSchema,
	lineRangeContains,
	lineRangeForLines,
	lineRangeSchema,
	lineRangesContain,
	normalizeLineRanges,
} from "./versioned/model";
export {
	decodeEscapedPatchPath,
	getPatchResourcePath,
	rewritePatchResourcePath,
} from "./versioned/patch";
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

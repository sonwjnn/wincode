// biome-ignore-all lint/performance/noBarrelFile: Public coding tools module entry point.

export {
	codingToolCatalog,
	codingToolDefinitionFor,
	codingToolNames,
} from "./catalog";
export { isRenderableEditDiff } from "./edit/diff";
export { validateMultiEditPatch } from "./edit/multi";
export { getReadResourcePath } from "./read/selector";
export type {
	ResourceLimitProfile,
	ToolResourceLimits,
} from "./resource-limits";
export {
	DEFAULT_RESOURCE_LIMIT_PROFILE,
	getToolResourceLimits,
	isElevatedResourceProfile,
	RESOURCE_LIMIT_PERMISSION_ACTION,
	resourceLimitProfileSchema,
} from "./resource-limits";
export type { CodingToolRunnerOptions } from "./runners";
export {
	runEditTool,
	runGlobTool,
	runGrepTool,
	runReadTool,
	runRecoverTool,
	runShellTool,
	runWriteTool,
} from "./runners";
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
	RecoverInput,
	RecoverOutput,
	ShellInput,
	ShellOutput,
	ShellPlatform,
	WriteInput,
	WriteOutput,
} from "./schemas";
export {
	composeShellToolDescription,
	editInputSchema,
	editInputSchemaForMode,
	editOutputSchema,
	recoverInputSchema,
	recoverOutputSchema,
	recoverToolSchema,
	shellPlatformFromNode,
	writeInputSchema,
	writeOutputSchema,
} from "./schemas";
export { SHELL_OUTPUT_TAIL_BYTES } from "./shell/schema";
export type {
	CodingToolErrorDetails,
	CodingToolErrorOptions,
	CodingToolRecovery,
	EditMode,
	FileObservation,
	FileObservationStore,
	FileSnapshot,
	FullDiffArtifact,
	LeaseAssertion,
	PathLeaseOperation,
	VersionedEditingContext,
} from "./versioned/contracts";
export {
	CodingToolError,
	createFileObservation,
	createMemoryFileObservationStore,
	defaultVersionedEditingContext,
	editModeSchema,
	isCodingToolError,
	isCodingToolRecovery,
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
	getPatchResourcePaths,
	rewritePatchResourcePath,
	rewritePatchResourcePaths,
} from "./versioned/patch";
export type {
	RecoveryArtifact,
	RecoveryArtifactPath,
	RecoveryInspection,
	RecoveryPathStatus,
	RecoveryReconciliation,
	RecoveryStore,
	RecoveryTransaction,
	RecoveryTransactionInput,
	RecoveryTransactionPath,
	RecoveryTransactionStatus,
	UnresolvedRecovery,
	UnresolvedRecoveryStatus,
} from "./versioned/recovery";
export { createMemoryRecoveryStore } from "./versioned/recovery";
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

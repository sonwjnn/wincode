import type { Stats } from "node:fs";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
	isObjectLike,
	isUndefined,
	omitUndefined,
	pickTruthy,
} from "@wincode/runtime-utils";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
	type ToolResourceLimits,
} from "../resource-limits";
import {
	CodingToolError,
	defaultVersionedEditingContext,
	isCodingToolError,
	type VersionedEditingContext,
} from "../versioned/contracts";
import {
	expandExternalPath,
	type FileState,
	parseUtf8Content,
	persistFileObservation,
	readVersionedFile,
	withFileMutationLock,
	withSnapshotFailureCleanup,
} from "../versioned/filesystem";
import {
	byteLength,
	type LosslessTextLine,
	lineRangeForLines,
} from "../versioned/model";
import {
	createWorkspaceSandbox,
	defaultWorkspaceSandbox,
	type WorkspacePolicy,
	type WorkspaceTraversalEntry,
} from "../workspace";
import type { ReadInput, ReadOutput } from "./schema";
import {
	type LineRange,
	normalizeLineRanges,
	splitLineRangeSelector,
} from "./selector";

const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;
const DIRECTORY_MAX_DEPTH = 2;
const DIRECTORY_CHILD_LIMIT = 12;
const DIRECTORY_ROOT_ENTRY_NUMBER = 1;
const DIRECTORY_FIRST_CHILD_DEPTH = 1;
const SYMLINK_TARGET_MAX_CHARS = 512;
type ResolvedReadTarget =
	| {
			absolutePath: string;
			kind: "file";
			path: string;
			ranges?: LineRange[];
			state: FileState;
	  }
	| {
			absolutePath: string;
			kind: "directory";
			path: string;
			ranges?: LineRange[];
	  }
	| {
			absolutePath: string;
			kind: "symlink";
			path: string;
			ranges?: LineRange[];
			symlinkTarget: string;
	  };
type ReadToolOptions = ResourceLimitOptions & {
	allowExternalPath?: boolean;
	versionedEditing?: VersionedEditingContext;
};
const hasErrorCode = (
	error: unknown,
	code: string
): error is NodeJS.ErrnoException =>
	isObjectLike(error) && "code" in error && error.code === code;

const readResolvedTarget = async (
	resolvedPath: string,
	displayPath: string,
	ranges?: LineRange[]
): Promise<ResolvedReadTarget> => {
	const targetStat = await stat(resolvedPath);
	if (targetStat.isDirectory()) {
		return {
			absolutePath: resolvedPath,
			kind: "directory",
			path: displayPath,
			...omitUndefined({ ranges }),
		};
	}
	return {
		absolutePath: resolvedPath,
		kind: "file",
		path: displayPath,
		state: await readVersionedFile(resolvedPath),
		...omitUndefined({ ranges }),
	};
};

const readTextTarget = async (
	inputPath: string,
	allowExternalPath: boolean
): Promise<ResolvedReadTarget> => {
	const resolvePath = async (candidatePath: string): Promise<string> => {
		const externalPath = expandExternalPath(candidatePath);
		return allowExternalPath && path.isAbsolute(externalPath)
			? realpath(externalPath)
			: defaultWorkspaceSandbox.resolveExistingPath(candidatePath);
	};
	const readCandidateTarget = async (
		candidatePath: string,
		displayPath: string,
		ranges?: LineRange[]
	): Promise<ResolvedReadTarget | undefined> => {
		const externalPath = expandExternalPath(candidatePath);
		const literalPath =
			allowExternalPath && path.isAbsolute(externalPath)
				? externalPath
				: await defaultWorkspaceSandbox.resolveNewPath(candidatePath);
		const literalStat = await lstat(literalPath).catch(
			(error: unknown): Stats | undefined => {
				if (hasErrorCode(error, "ENOENT")) {
					return;
				}
				throw error;
			}
		);
		if (isUndefined(literalStat)) {
			return;
		}
		const resolvedPath = await resolvePath(candidatePath);
		const resolvedTarget = await readResolvedTarget(
			resolvedPath,
			displayPath,
			ranges
		);
		if (literalStat.isSymbolicLink() && resolvedTarget.kind === "directory") {
			return {
				absolutePath: resolvedPath,
				kind: "symlink",
				path: displayPath,
				...omitUndefined({ ranges }),
				symlinkTarget: await readlink(literalPath),
			};
		}
		return resolvedTarget;
	};

	let missingLiteralError: unknown;
	try {
		const literalTarget = await readCandidateTarget(inputPath, inputPath);
		if (literalTarget) {
			return literalTarget;
		}
		await resolvePath(inputPath);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) {
			throw error;
		}
		missingLiteralError = error;
	}
	const externalInputPath = expandExternalPath(inputPath);
	const literalPath =
		allowExternalPath && path.isAbsolute(externalInputPath)
			? externalInputPath
			: await defaultWorkspaceSandbox.resolveNewPath(inputPath);
	let literalEntryExists = true;
	try {
		await lstat(literalPath);
	} catch (error) {
		if (!hasErrorCode(error, "ENOENT")) {
			throw error;
		}
		literalEntryExists = false;
	}
	if (literalEntryExists) {
		throw missingLiteralError;
	}
	const target = splitLineRangeSelector(inputPath);
	if (!target.ranges) {
		throw missingLiteralError;
	}
	const resolvedTarget = await readCandidateTarget(
		target.path,
		target.path,
		target.ranges
	);
	if (!resolvedTarget) {
		throw missingLiteralError;
	}
	return resolvedTarget;
};

type NumberedContent = {
	content: string;
	truncated: boolean;
};
type NumberedLine = {
	lineNumber?: number;
	text: string;
};

const remainingRangesAfter = (
	ranges: readonly LineRange[],
	lastSelectedLine: number | undefined,
	totalLines: number
): LineRange[] => {
	const remainingRanges: LineRange[] = [];
	for (const range of ranges) {
		const rangeEnd = range.endLine ?? totalLines;
		if (isUndefined(lastSelectedLine) || lastSelectedLine < range.startLine) {
			remainingRanges.push({ ...range });
		} else if (lastSelectedLine < rangeEnd) {
			remainingRanges.push({
				...omitUndefined({ endLine: range.endLine }),
				startLine: lastSelectedLine + 1,
			});
		}
	}
	return remainingRanges;
};

const continuationNotice = (
	filePath: string,
	ranges: readonly LineRange[],
	maxOutputBytes: number
): string => {
	const selector = ranges
		.map((range) =>
			isUndefined(range.endLine)
				? `${range.startLine}-`
				: `${range.startLine}-${range.endLine}`
		)
		.join(",");
	return `[Output capped at ${maxOutputBytes} bytes. Continue with path \`${filePath}:${selector}\`.]`;
};

const buildDisplayRanges = (
	lines: readonly string[],
	selectedRanges: readonly LineRange[]
): LineRange[] =>
	normalizeLineRanges(
		selectedRanges.map((range) => ({
			endLine: Math.min(
				lines.length,
				(range.endLine ?? lines.length) + RANGE_TRAILING_CONTEXT_LINES
			),
			startLine: Math.max(1, range.startLine - RANGE_LEADING_CONTEXT_LINES),
		}))
	);

type DirectoryTreeLine = {
	entryNumber?: number;
	parentPath?: string;
	text: string;
};

type DirectoryTree = {
	entryCount: number;
	lines: DirectoryTreeLine[];
	truncated: boolean;
};

type DirectoryTraversal = {
	rootPath: string;
	entries: readonly WorkspaceTraversalEntry[];
};

const sanitizeSymlinkTarget = (target: string): string => {
	const sanitized = Array.from(target, (character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
	}).join("");
	const characters = Array.from(sanitized);
	return characters.length > SYMLINK_TARGET_MAX_CHARS
		? `${characters.slice(0, SYMLINK_TARGET_MAX_CHARS - 1).join("")}…`
		: sanitized;
};

const buildDirectoryTree = (
	rootPath: string,
	entries: readonly WorkspaceTraversalEntry[]
): DirectoryTree => {
	type DirectoryNode = {
		entry: WorkspaceTraversalEntry;
		name: string;
		relativePath: string;
	};

	const childrenByParent = new Map<string, DirectoryNode[]>();
	for (const entry of entries) {
		const relativePath = path
			.relative(rootPath, entry.absolutePath)
			.split(path.sep)
			.join("/");
		if (relativePath === "" || relativePath.startsWith("../")) {
			continue;
		}
		const parentPath = path.posix.dirname(relativePath);
		const bucket = childrenByParent.get(parentPath === "." ? "" : parentPath);
		const node = {
			entry,
			name: path.posix.basename(relativePath),
			relativePath,
		};
		if (bucket) {
			bucket.push(node);
		} else {
			childrenByParent.set(parentPath === "." ? "" : parentPath, [node]);
		}
	}

	const lines: DirectoryTreeLine[] = [
		{ entryNumber: DIRECTORY_ROOT_ENTRY_NUMBER, text: "." },
	];
	let nextEntryNumber = DIRECTORY_ROOT_ENTRY_NUMBER + 1;
	let truncated = false;
	const renderChildren = (parentPath: string, depth: number): void => {
		const children = (childrenByParent.get(parentPath) ?? []).toSorted(
			(left, right) => {
				const directoryOrder =
					Number(right.entry.type === "directory") -
					Number(left.entry.type === "directory");
				return directoryOrder || left.name.localeCompare(right.name);
			}
		);
		const visibleChildren = children.slice(0, DIRECTORY_CHILD_LIMIT);
		for (const child of visibleChildren) {
			const symlinkSuffix = isUndefined(child.entry.symlinkTarget)
				? ""
				: ` -> ${sanitizeSymlinkTarget(child.entry.symlinkTarget)}`;
			const suffix = child.entry.type === "directory" ? "/" : symlinkSuffix;
			lines.push({
				entryNumber: nextEntryNumber,
				parentPath,
				text: `${"  ".repeat(depth)}- ${child.name}${suffix}`,
			});
			nextEntryNumber += 1;
			if (child.entry.type === "directory" && depth < DIRECTORY_MAX_DEPTH) {
				renderChildren(child.relativePath, depth + 1);
			}
		}
		if (children.length > DIRECTORY_CHILD_LIMIT) {
			truncated = true;
			lines.push({
				parentPath,
				text: `${"  ".repeat(depth)}- … ${
					children.length - DIRECTORY_CHILD_LIMIT
				} more`,
			});
		}
	};
	renderChildren("", DIRECTORY_FIRST_CHILD_DEPTH);

	return {
		entryCount: nextEntryNumber - DIRECTORY_ROOT_ENTRY_NUMBER,
		lines,
		truncated,
	};
};

const isWithinRange = (lineNumber: number, ranges: readonly LineRange[]) =>
	ranges.some(
		(range) =>
			lineNumber >= range.startLine &&
			(isUndefined(range.endLine) || lineNumber <= range.endLine)
	);

const selectDirectoryLines = (
	lines: readonly DirectoryTreeLine[],
	ranges: readonly LineRange[]
): DirectoryTreeLine[] => {
	const selectedParents = new Set<string>();
	for (const line of lines) {
		if (
			!isUndefined(line.entryNumber) &&
			isWithinRange(line.entryNumber, ranges) &&
			!isUndefined(line.parentPath)
		) {
			selectedParents.add(line.parentPath);
		}
	}
	return lines.filter((line) => {
		if (!isUndefined(line.entryNumber)) {
			return isWithinRange(line.entryNumber, ranges);
		}
		return (
			!isUndefined(line.parentPath) && selectedParents.has(line.parentPath)
		);
	});
};

const traverseDirectory = async (
	absolutePath: string,
	allowExternalPath: boolean
): Promise<DirectoryTraversal> => {
	let sandbox: WorkspacePolicy = defaultWorkspaceSandbox;
	let traversalPath = absolutePath;
	let rootPath: string;
	try {
		rootPath = await defaultWorkspaceSandbox.resolveExistingPath(absolutePath);
	} catch (error) {
		if (!(allowExternalPath && path.isAbsolute(absolutePath))) {
			throw error;
		}
		sandbox = createWorkspaceSandbox(absolutePath);
		rootPath = sandbox.root;
		traversalPath = ".";
	}
	const traversal = await sandbox.traverse({
		allowIgnoredRoot: true,
		hideDotfiles: true,
		includeDirectories: true,
		includeFiles: true,
		includeSymlinks: true,
		maxDepth: DIRECTORY_MAX_DEPTH,
		path: traversalPath,
		applyGitignore: true,
	});
	return { entries: traversal.entries, rootPath };
};

type BoundedOutputLine = NumberedLine & {
	selectedLine?: number;
	skipIfOverBudget?: boolean;
};

type BoundOutputOptions = {
	filePath: string;
	firstLineError: string;
	getRemainingRanges: (
		lastSelectedLine: number | undefined,
		lastDisplayedLine: number | undefined
	) => LineRange[];
	lines: Iterable<BoundedOutputLine>;
	maxOutputBytes: number;
	oversizedLineMessage?: (line: BoundedOutputLine) => string | undefined;
};

const boundOutputLines = ({
	filePath,
	firstLineError,
	getRemainingRanges,
	lines,
	maxOutputBytes,
	oversizedLineMessage,
}: BoundOutputOptions): NumberedContent => {
	const acceptedLines: string[] = [];
	let acceptedBytes = 0;
	let failedLine: BoundedOutputLine | undefined;
	let lastDisplayedLine: number | undefined;
	let lastSelectedLine: number | undefined;
	let truncated = false;
	for (const line of lines) {
		const nextLastDisplayedLine = line.lineNumber ?? lastDisplayedLine;
		const nextLastSelectedLine = line.selectedLine ?? lastSelectedLine;
		const remainingRanges = getRemainingRanges(
			nextLastSelectedLine,
			nextLastDisplayedLine
		);
		const noticeBytes =
			remainingRanges.length === 0
				? 0
				: Buffer.byteLength(
						`\n\n${continuationNotice(
							filePath,
							remainingRanges,
							maxOutputBytes
						)}`,
						"utf8"
					);
		const separatorBytes = acceptedLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(line.text, "utf8");
		if (
			acceptedBytes + separatorBytes + lineBytes + noticeBytes >
			maxOutputBytes
		) {
			truncated = true;
			if (line.skipIfOverBudget) {
				continue;
			}
			failedLine = line;
			break;
		}
		acceptedLines.push(line.text);
		acceptedBytes += separatorBytes + lineBytes;
		lastDisplayedLine = nextLastDisplayedLine;
		lastSelectedLine = nextLastSelectedLine;
	}
	if (!truncated) {
		return {
			content: acceptedLines.join("\n"),
			truncated: false,
		};
	}
	if (acceptedLines.length === 0) {
		const oversizedLine = isUndefined(failedLine)
			? undefined
			: oversizedLineMessage?.(failedLine);
		throw new CodingToolError(
			"read-output-out-of-budget",
			oversizedLine ?? firstLineError,
			{
				details: { maxOutputBytes, path: filePath },
				recovery: { action: "correct-input", path: filePath },
			}
		);
	}
	const remainingRanges = getRemainingRanges(
		lastSelectedLine,
		lastDisplayedLine
	);
	return {
		content:
			remainingRanges.length === 0
				? acceptedLines.join("\n")
				: `${acceptedLines.join("\n")}\n\n${continuationNotice(
						filePath,
						remainingRanges,
						maxOutputBytes
					)}`,
		truncated: true,
	};
};

const boundDirectoryLines = (
	lines: readonly DirectoryTreeLine[],
	selectedRanges: readonly LineRange[],
	entryCount: number,
	filePath: string,
	maxOutputBytes: number
): NumberedContent => {
	const renderedContent = lines.map(({ text }) => text).join("\n");
	if (Buffer.byteLength(renderedContent, "utf8") <= maxOutputBytes) {
		return { content: renderedContent, truncated: false };
	}

	return boundOutputLines({
		filePath,
		firstLineError: `The first directory output line cannot fit with its continuation notice within the ${maxOutputBytes}-byte read limit`,
		getRemainingRanges: (lastSelectedLine) =>
			remainingRangesAfter(selectedRanges, lastSelectedLine, entryCount),
		lines: lines.map((line) => ({
			lineNumber: line.entryNumber,
			selectedLine: line.entryNumber,
			skipIfOverBudget: isUndefined(line.entryNumber),
			text: line.text,
		})),
		maxOutputBytes,
	});
};

const formatDirectoryContent = async (
	absolutePath: string,
	filePath: string,
	ranges: readonly LineRange[] | undefined,
	allowExternalPath: boolean,
	maxOutputBytes: number
): Promise<NumberedContent> => {
	const traversal = await traverseDirectory(absolutePath, allowExternalPath);
	const tree = buildDirectoryTree(traversal.rootPath, traversal.entries);
	const outOfBoundsRange = ranges?.find(
		(range) => range.startLine > tree.entryCount
	);
	if (outOfBoundsRange) {
		throw new CodingToolError(
			"line-range-out-of-bounds",
			`Line range starts at ${outOfBoundsRange.startLine}, beyond end of directory listing (${tree.entryCount} entries)`,
			{
				details: { path: filePath, range: outOfBoundsRange },
				recovery: { action: "correct-input", path: filePath },
			}
		);
	}
	if (tree.lines.length === 1) {
		return { content: "(empty directory)", truncated: false };
	}
	const selectedRanges = normalizeLineRanges(
		ranges ?? [{ endLine: tree.entryCount, startLine: 1 }]
	);
	const selectedLines = isUndefined(ranges)
		? tree.lines
		: selectDirectoryLines(tree.lines, selectedRanges);
	const bounded = boundDirectoryLines(
		selectedLines,
		selectedRanges,
		tree.entryCount,
		filePath,
		maxOutputBytes
	);
	return {
		content: bounded.content,
		truncated: bounded.truncated || tree.truncated,
	};
};

type VersionedNumberedContent = NumberedContent & {
	continuationRanges: LineRange[];
	displayedRanges: LineRange[];
	seenLines: LineRange[];
};

const truncateDisplayedLine = (
	text: string,
	maxBytes: number
): { text: string; truncated: boolean } => {
	if (byteLength(text) <= maxBytes) {
		return { text, truncated: false };
	}
	let result = "";
	for (const character of text) {
		const candidate = `${result}${character}…`;
		if (byteLength(candidate) > maxBytes) {
			break;
		}
		result += character;
	}
	return { text: `${result}…`, truncated: true };
};
type VersionedDisplay = {
	continuationLine?: number;
	displayed: string[];
	displayedLineNumbers: number[];
	seenLineNumbers: number[];
	truncated: boolean;
};

const appendVersionedLine = ({
	acceptedBytes,
	displayed,
	displayedLineNumbers,
	fullLines,
	line,
	lineNumber,
	limits,
	seenLineNumbers,
}: {
	acceptedBytes: number;
	displayed: string[];
	displayedLineNumbers: number[];
	fullLines: boolean;
	line: LosslessTextLine;
	lineNumber: number;
	limits: ToolResourceLimits["read"];
	seenLineNumbers: number[];
}): { acceptedBytes: number; truncated: boolean } => {
	const renderedLine = fullLines
		? { text: line.text, truncated: false }
		: truncateDisplayedLine(line.text, limits.maxLineBytes);
	const lineContent = `${lineNumber}:${renderedLine.text}`;
	const nextBytes =
		acceptedBytes + (displayed.length === 0 ? 0 : 1) + byteLength(lineContent);
	if (
		displayed.length >= limits.maxOutputLines ||
		nextBytes > limits.maxOutputBytes
	) {
		return { acceptedBytes, truncated: true };
	}
	displayed.push(lineContent);
	displayedLineNumbers.push(lineNumber);
	if (!renderedLine.truncated) {
		seenLineNumbers.push(lineNumber);
	}
	return { acceptedBytes: nextBytes, truncated: renderedLine.truncated };
};
const collectVersionedLines = (
	lines: readonly LosslessTextLine[],
	displayRanges: readonly LineRange[],
	filePath: string,
	limits: ToolResourceLimits["read"],
	fullLines: boolean
): VersionedDisplay => {
	const displayed: string[] = [];
	const displayedLineNumbers: number[] = [];
	const seenLineNumbers: number[] = [];
	let acceptedBytes = 0;
	let continuationLine: number | undefined;
	let truncated = false;
	for (const range of displayRanges) {
		const endLine = range.endLine ?? range.startLine;
		for (
			let lineNumber = range.startLine;
			lineNumber <= endLine;
			lineNumber += 1
		) {
			const line = lines[lineNumber - 1];
			if (line === undefined) {
				continue;
			}
			const result = appendVersionedLine({
				acceptedBytes,
				displayed,
				displayedLineNumbers,
				fullLines,
				line,
				lineNumber,
				limits,
				seenLineNumbers,
			});
			if (result.truncated && continuationLine === undefined) {
				continuationLine = lineNumber;
			}
			if (result.truncated && displayed.length === 0) {
				const lineRange = { startLine: lineNumber };
				throw new CodingToolError(
					"read-output-out-of-budget",
					`The first requested line cannot fit within the ${limits.maxOutputBytes}-byte read limit.`,
					{
						details: {
							lineRange,
							maxOutputBytes: limits.maxOutputBytes,
							path: filePath,
						},
						recovery: {
							action: "correct-input",
							lineRange,
							path: filePath,
						},
					}
				);
			}
			acceptedBytes = result.acceptedBytes;
			truncated ||= result.truncated;
		}
	}
	return {
		continuationLine,
		displayed,
		displayedLineNumbers,
		seenLineNumbers,
		truncated,
	};
};

const formatVersionedFileContent = (
	lines: readonly LosslessTextLine[],
	filePath: string,
	ranges: readonly LineRange[] | undefined,
	limits: ToolResourceLimits["read"],
	fullLines: boolean
): VersionedNumberedContent => {
	const lineTexts = lines.map((line) => line.text);
	const outOfBoundsRange = ranges?.find(
		(range) => range.startLine > lines.length
	);
	if (outOfBoundsRange) {
		throw new CodingToolError(
			"line-range-out-of-bounds",
			`Line range starts at ${outOfBoundsRange.startLine}, beyond end of file (${lines.length} lines).`,
			{
				details: { path: filePath, range: outOfBoundsRange },
				recovery: { action: "correct-input", path: filePath },
			}
		);
	}
	if (lines.length === 0) {
		return {
			content: "",
			continuationRanges: [],
			displayedRanges: [],
			seenLines: [],
			truncated: false,
		};
	}
	const selectedRanges = normalizeLineRanges(
		ranges ?? [{ endLine: lines.length, startLine: 1 }]
	);
	const displayRanges = buildDisplayRanges(lineTexts, selectedRanges);
	const display = collectVersionedLines(
		lines,
		displayRanges,
		filePath,
		limits,
		fullLines
	);
	const continuationRanges =
		display.truncated && display.continuationLine !== undefined
			? remainingRangesAfter(
					displayRanges,
					display.continuationLine - 1,
					lines.length
				)
			: [];
	return {
		content: display.displayed.join("\n"),
		continuationRanges,
		displayedRanges: lineRangeForLines(display.displayedLineNumbers),
		seenLines: lineRangeForLines(display.seenLineNumbers),
		truncated: display.truncated,
	};
};

const formatNonFileRead = async (
	target: Exclude<ResolvedReadTarget, { kind: "file" }>,
	input: ReadInput,
	limits: ToolResourceLimits["read"],
	allowExternalPath: boolean,
	previousObservation: Awaited<
		ReturnType<VersionedEditingContext["store"]["getLatestObservation"]>
	>
): Promise<ReadOutput> => {
	if (input.expectedVersion !== undefined || previousObservation !== null) {
		throw new CodingToolError(
			"file-version-mismatch",
			`Read continuation target '${target.path}' is no longer a text file.`,
			{
				details: {
					...omitUndefined({
						expected: input.expectedVersion,
						previous: previousObservation?.fileVersion,
					}),
					path: target.path,
					targetKind: target.kind,
				},
				recovery: { action: "reread", path: target.path },
			}
		);
	}
	if (target.kind === "directory") {
		const formattedContent = await formatDirectoryContent(
			target.absolutePath,
			target.path,
			target.ranges,
			allowExternalPath,
			limits.maxDirectoryOutputBytes
		);
		return {
			content: formattedContent.content,
			path: target.path,
			...pickTruthy({ truncated: formattedContent.truncated }),
		};
	}
	return {
		content: sanitizeSymlinkTarget(target.symlinkTarget),
		path: target.path,
	};
};
const readFullDiffArtifact = async (
	input: ReadInput,
	limits: ToolResourceLimits,
	context: VersionedEditingContext
): Promise<ReadOutput | undefined> => {
	if (!input.path.startsWith("artifact://")) {
		return;
	}
	if (input.expectedVersion !== undefined) {
		throw new CodingToolError(
			"artifact-version-unsupported",
			"Full Diff Artifacts do not have File Versions.",
			{ recovery: { action: "correct-input", path: input.path } }
		);
	}
	const resource = input.path.slice("artifact://".length);
	const selectorIndex = resource.indexOf(":");
	const artifactId =
		selectorIndex < 0 ? resource : resource.slice(0, selectorIndex);
	if (artifactId.length === 0) {
		throw new CodingToolError(
			"artifact-not-found",
			"Full Diff Artifact id is missing.",
			{ recovery: { action: "correct-input", path: input.path } }
		);
	}
	const artifact = await context.store.getFullDiffArtifact?.(
		context.sessionId,
		artifactId
	);
	if (artifact === undefined || artifact === null) {
		throw new CodingToolError(
			"artifact-not-found",
			`Full Diff Artifact '${artifactId}' was not found.`,
			{ recovery: { action: "correct-input", path: input.path } }
		);
	}
	const selector =
		selectorIndex < 0
			? undefined
			: splitLineRangeSelector(
					`artifact-${artifactId}${resource.slice(selectorIndex)}`
				).ranges;
	const formatted = formatVersionedFileContent(
		parseUtf8Content(artifact.content).text.lines,
		`artifact://${artifactId}`,
		selector,
		limits.read,
		input.fullLines === true
	);
	return {
		content: formatted.content,
		continuationRanges: formatted.continuationRanges,
		displayedRanges: formatted.displayedRanges,
		path: input.path,
		...pickTruthy({ truncated: formatted.truncated }),
	};
};

export const runReadTool = async (
	input: ReadInput,
	options: ReadToolOptions = {}
): Promise<ReadOutput> => {
	const limits = options.resourceLimits ?? getToolResourceLimits();
	const context = options.versionedEditing ?? defaultVersionedEditingContext;
	const artifact = await readFullDiffArtifact(input, limits, context);
	if (artifact !== undefined) {
		return artifact;
	}
	const target = await readTextTarget(
		input.path,
		options.allowExternalPath === true
	);
	const previousObservation = await context.store.getLatestObservation(
		context.sessionId,
		target.absolutePath
	);
	if (target.kind !== "file") {
		return formatNonFileRead(
			target,
			input,
			limits.read,
			options.allowExternalPath === true,
			previousObservation
		);
	}
	try {
		const persisted = await withFileMutationLock(
			target.absolutePath,
			async () => {
				const currentState = await readVersionedFile(target.absolutePath);
				const currentObservation = await context.store.getLatestObservation(
					context.sessionId,
					target.absolutePath
				);
				if (
					currentObservation !== null &&
					input.expectedVersion === undefined
				) {
					throw new CodingToolError(
						"expected-file-version",
						`Read continuation requires the current File Version for '${target.path}'.`,
						{
							details: {
								current: currentState.fileVersion,
								previous: currentObservation.fileVersion,
								path: target.path,
							},
							recovery: {
								action: "provide-file-version",
								currentFileVersion: currentState.fileVersion,
								path: target.path,
							},
						}
					);
				}
				if (
					input.expectedVersion !== undefined &&
					input.expectedVersion !== currentState.fileVersion
				) {
					throw new CodingToolError(
						"file-version-mismatch",
						`Read continuation expected ${input.expectedVersion}, got ${currentState.fileVersion}.`,
						{
							details: {
								actual: currentState.fileVersion,
								expected: input.expectedVersion,
								path: target.path,
							},
							recovery: {
								action: "reread",
								currentFileVersion: currentState.fileVersion,
								path: target.path,
							},
						}
					);
				}
				const formattedContent = formatVersionedFileContent(
					currentState.text.lines,
					target.path,
					target.ranges,
					limits.read,
					input.fullLines === true
				);
				const observation = await withSnapshotFailureCleanup(
					context,
					{
						fileVersion: currentState.fileVersion,
						path: target.absolutePath,
					},
					() =>
						persistFileObservation({
							context,
							limits,
							path: target.absolutePath,
							seenLines: formattedContent.seenLines,
							state: currentState,
						})
				);
				return { currentState, formattedContent, observation };
			}
		);
		return {
			content: persisted.formattedContent.content,
			continuationRanges: persisted.formattedContent.continuationRanges,
			displayedRanges: persisted.formattedContent.displayedRanges,
			fileVersion: persisted.currentState.fileVersion,
			observationId: persisted.observation.id,
			path: target.path,
			seenLines: [...persisted.observation.seenLines],
			snapshotAvailable: persisted.observation.snapshotAvailable,
			...pickTruthy({ truncated: persisted.formattedContent.truncated }),
		};
	} catch (error) {
		if (isCodingToolError(error)) {
			throw error;
		}
		throw new CodingToolError(
			"observation-persistence-failed",
			"Could not persist the file observation.",
			{
				details: { path: target.path },
				recovery: { action: "reread", path: target.path },
			}
		);
	}
};

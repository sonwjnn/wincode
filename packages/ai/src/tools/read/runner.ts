import { lstat, readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
import {
	createWorkspaceSandbox,
	defaultWorkspaceSandbox,
	type WorkspacePolicy,
	type WorkspaceTraversalEntry,
} from "../../workspace";

const HASHLINE_PREFIX_PATTERN = /^(\d+):(.*)$/u;
const HASHLINE_CR_PATTERN = /\r$/u;
const HASHLINE_OFFSET_BASIS = 2_166_136_261;
const HASHLINE_PRIME = 16_777_619;
const HASHLINE_ALPHABET_OFFSET = 97;
const HASHLINE_ALPHABET_SIZE = 26;

const hashlineFor = (line: string): string => {
	let hash = HASHLINE_OFFSET_BASIS;
	for (const byte of Buffer.from(line, "utf8")) {
		// biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a requires 32-bit arithmetic.
		hash ^= byte;
		// biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a requires unsigned 32-bit arithmetic.
		hash = Math.imul(hash, HASHLINE_PRIME) >>> 0;
	}
	return (
		String.fromCharCode(
			HASHLINE_ALPHABET_OFFSET + (hash % HASHLINE_ALPHABET_SIZE)
		) +
		String.fromCharCode(
			HASHLINE_ALPHABET_OFFSET +
				// biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a extracts the second byte.
				((hash >>> 8) % HASHLINE_ALPHABET_SIZE)
		)
	);
};

import {
	getToolResourceLimits,
	type ResourceLimitOptions,
} from "../resource-limits";
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
			content: string;
			kind: "file";
			path: string;
			ranges?: LineRange[];
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
};
const hasErrorCode = (
	error: unknown,
	code: string
): error is NodeJS.ErrnoException =>
	typeof error === "object" &&
	error !== null &&
	"code" in error &&
	error.code === code;

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
			...(ranges === undefined ? {} : { ranges }),
		};
	}
	return {
		absolutePath: resolvedPath,
		content: await readFile(resolvedPath, "utf8"),
		kind: "file",
		path: displayPath,
		...(ranges === undefined ? {} : { ranges }),
	};
};

const readTextTarget = async (
	inputPath: string,
	allowExternalPath: boolean
): Promise<ResolvedReadTarget> => {
	const resolvePath = async (candidatePath: string): Promise<string> =>
		allowExternalPath && path.isAbsolute(candidatePath)
			? candidatePath
			: defaultWorkspaceSandbox.resolveExistingPath(candidatePath);
	const readCandidateTarget = async (
		candidatePath: string,
		displayPath: string,
		ranges?: LineRange[]
	): Promise<ResolvedReadTarget | undefined> => {
		const literalPath =
			allowExternalPath && path.isAbsolute(candidatePath)
				? candidatePath
				: await defaultWorkspaceSandbox.resolveNewPath(candidatePath);
		const literalStat = await lstat(literalPath).catch((error: unknown) => {
			if (hasErrorCode(error, "ENOENT")) {
				return;
			}
			throw error;
		});
		if (literalStat === undefined) {
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
				...(ranges === undefined ? {} : { ranges }),
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
	const literalPath =
		allowExternalPath && path.isAbsolute(inputPath)
			? inputPath
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
const splitAddressableLines = (content: string): string[] => {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
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
		if (lastSelectedLine === undefined || lastSelectedLine < range.startLine) {
			remainingRanges.push({ ...range });
		} else if (lastSelectedLine < rangeEnd) {
			remainingRanges.push({
				...(range.endLine === undefined ? {} : { endLine: range.endLine }),
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
			range.endLine === undefined
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

function* numberedLinesInRanges(
	lines: readonly string[],
	displayRanges: readonly LineRange[]
): Generator<NumberedLine> {
	for (const [rangeIndex, range] of displayRanges.entries()) {
		if (rangeIndex > 0) {
			yield { text: "…" };
		}
		for (
			let lineNumber = range.startLine;
			lineNumber <= (range.endLine ?? lines.length);
			lineNumber += 1
		) {
			yield {
				lineNumber,
				text: `${lineNumber}:${lines[lineNumber - 1] ?? ""}`,
			};
		}
	}
}

const fitsOutputBudget = (
	lines: readonly string[],
	displayRanges: readonly LineRange[],
	maxOutputBytes: number
): boolean => {
	let bytes = 0;
	let lineCount = 0;
	for (const numberedLine of numberedLinesInRanges(lines, displayRanges)) {
		bytes +=
			(lineCount === 0 ? 0 : 1) + Buffer.byteLength(numberedLine.text, "utf8");
		if (bytes > maxOutputBytes) {
			return false;
		}
		lineCount += 1;
	}
	return true;
};

const continuationRangesAfter = (
	selectedRanges: readonly LineRange[],
	displayRanges: readonly LineRange[],
	lastSelectedLine: number | undefined,
	lastDisplayedLine: number | undefined,
	totalLines: number
): LineRange[] => {
	const selectedRemaining = remainingRangesAfter(
		selectedRanges,
		lastSelectedLine,
		totalLines
	);
	const displayRemaining = remainingRangesAfter(
		displayRanges,
		lastDisplayedLine,
		totalLines
	);
	const firstSelectedStart = selectedRemaining[0]?.startLine;
	if (firstSelectedStart === undefined) {
		return displayRemaining;
	}
	const omittedTrailingContext = displayRemaining.filter(
		(range) => (range.endLine ?? totalLines) < firstSelectedStart
	);
	return normalizeLineRanges([...omittedTrailingContext, ...selectedRemaining]);
};
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
			const symlinkSuffix =
				child.entry.symlinkTarget === undefined
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
			(range.endLine === undefined || lineNumber <= range.endLine)
	);

const selectDirectoryLines = (
	lines: readonly DirectoryTreeLine[],
	ranges: readonly LineRange[]
): DirectoryTreeLine[] => {
	const selectedParents = new Set<string>();
	for (const line of lines) {
		if (
			line.entryNumber !== undefined &&
			isWithinRange(line.entryNumber, ranges) &&
			line.parentPath !== undefined
		) {
			selectedParents.add(line.parentPath);
		}
	}
	return lines.filter((line) => {
		if (line.entryNumber !== undefined) {
			return isWithinRange(line.entryNumber, ranges);
		}
		return (
			line.parentPath !== undefined && selectedParents.has(line.parentPath)
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
		const oversizedLine =
			failedLine === undefined ? undefined : oversizedLineMessage?.(failedLine);
		throw new Error(oversizedLine ?? firstLineError);
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
			skipIfOverBudget: line.entryNumber === undefined,
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
		throw new Error(
			`Line range starts at ${outOfBoundsRange.startLine}, beyond end of directory listing (${tree.entryCount} entries)`
		);
	}
	if (tree.lines.length === 1) {
		return { content: "(empty directory)", truncated: false };
	}
	const selectedRanges = normalizeLineRanges(
		ranges ?? [{ endLine: tree.entryCount, startLine: 1 }]
	);
	const selectedLines =
		ranges === undefined
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

const boundNumberedLines = (
	lines: readonly string[],
	selectedRanges: readonly LineRange[],
	displayRanges: readonly LineRange[],
	filePath: string,
	maxOutputBytes: number
): NumberedContent => {
	if (fitsOutputBudget(lines, displayRanges, maxOutputBytes)) {
		return {
			content: Array.from(
				numberedLinesInRanges(lines, displayRanges),
				({ text }) => text
			).join("\n"),
			truncated: false,
		};
	}

	function* boundedLines(): Generator<BoundedOutputLine> {
		for (const numberedLine of numberedLinesInRanges(lines, displayRanges)) {
			yield {
				...numberedLine,
				selectedLine:
					numberedLine.lineNumber !== undefined &&
					isWithinRange(numberedLine.lineNumber, selectedRanges)
						? numberedLine.lineNumber
						: undefined,
			};
		}
	}

	return boundOutputLines({
		filePath,
		firstLineError: `The first output line cannot fit with its continuation notice within the ${maxOutputBytes}-byte read limit`,
		getRemainingRanges: (lastSelectedLine, lastDisplayedLine) =>
			continuationRangesAfter(
				selectedRanges,
				displayRanges,
				lastSelectedLine,
				lastDisplayedLine,
				lines.length
			),
		lines: boundedLines(),
		maxOutputBytes,
		oversizedLineMessage: (line) => {
			if (line.lineNumber === undefined) {
				return;
			}
			const lineBytes = Buffer.byteLength(line.text, "utf8");
			return lineBytes > maxOutputBytes
				? `Line ${line.lineNumber} exceeds the ${maxOutputBytes}-byte read limit`
				: undefined;
		},
	});
};

const formatNumberedContent = (
	content: string,
	filePath: string,
	ranges: readonly LineRange[] | undefined,
	maxOutputBytes: number
): NumberedContent => {
	const lines = splitAddressableLines(content);
	const outOfBoundsRange = ranges?.find(
		(range) => range.startLine > lines.length
	);
	if (outOfBoundsRange) {
		throw new Error(
			`Line range starts at ${outOfBoundsRange.startLine}, beyond end of file (${lines.length} lines)`
		);
	}
	if (lines.length === 0) {
		return { content: "", truncated: false };
	}
	const selectedRanges = normalizeLineRanges(
		ranges ?? [{ endLine: lines.length, startLine: 1 }]
	);
	const displayRanges = buildDisplayRanges(lines, selectedRanges);
	return boundNumberedLines(
		lines,
		selectedRanges,
		displayRanges,
		filePath,
		maxOutputBytes
	);
};
const formatHashlineContent = (content: string): string =>
	content
		.split("\n")
		.map((line) => {
			const match = HASHLINE_PREFIX_PATTERN.exec(line);
			if (!match) {
				return line;
			}
			const lineNumber = match[1] as string;
			const text = (match[2] as string).replace(HASHLINE_CR_PATTERN, "");
			return `${lineNumber}:${hashlineFor(text)}|${text}`;
		})
		.join("\n");

export const runReadTool = async (
	input: ReadInput,
	options: ReadToolOptions = {}
): Promise<ReadOutput> => {
	const target = await readTextTarget(
		input.path,
		options.allowExternalPath === true
	);
	const limits = options.resourceLimits ?? getToolResourceLimits();
	let formattedContent: NumberedContent;
	if (target.kind === "directory") {
		formattedContent = await formatDirectoryContent(
			target.absolutePath,
			target.path,
			target.ranges,
			options.allowExternalPath === true,
			limits.read.maxDirectoryOutputBytes
		);
	} else if (target.kind === "symlink") {
		formattedContent = {
			content: sanitizeSymlinkTarget(target.symlinkTarget),
			truncated: false,
		};
	} else {
		formattedContent = formatNumberedContent(
			target.content,
			target.path,
			target.ranges,
			limits.read.maxOutputBytes
		);
	}
	if (input.hashline && target.kind === "file") {
		formattedContent = {
			...formattedContent,
			content: formatHashlineContent(formattedContent.content),
		};
	}
	return {
		content: formattedContent.content,
		path: target.path,
		...(formattedContent.truncated ? { truncated: true } : {}),
	};
};

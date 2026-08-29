import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceSandbox } from "../../workspace";
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
type ResolvedReadTarget = {
	content: string;
	path: string;
	ranges?: LineRange[];
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

const readTextTarget = async (
	inputPath: string,
	allowExternalPath: boolean
): Promise<ResolvedReadTarget> => {
	const resolvePath = async (candidatePath: string): Promise<string> =>
		allowExternalPath && path.isAbsolute(candidatePath)
			? candidatePath
			: defaultWorkspaceSandbox.resolveExistingPath(candidatePath);
	let missingLiteralError: unknown;
	try {
		const resolvedPath = await resolvePath(inputPath);
		return {
			content: await readFile(resolvedPath, "utf8"),
			path: inputPath,
		};
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
	const resolvedPath = await resolvePath(target.path);
	return {
		content: await readFile(resolvedPath, "utf8"),
		path: target.path,
		ranges: target.ranges,
	};
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
	const acceptedLines: string[] = [];
	let acceptedBytes = 0;
	let failedLine: NumberedLine | undefined;
	let lastDisplayedLine: number | undefined;
	let lastSelectedLine: number | undefined;
	for (const numberedLine of numberedLinesInRanges(lines, displayRanges)) {
		const separatorBytes = acceptedLines.length === 0 ? 0 : 1;
		const lineBytes = Buffer.byteLength(numberedLine.text, "utf8");
		const isSelectedLine =
			numberedLine.lineNumber !== undefined &&
			selectedRanges.some(
				(range) =>
					numberedLine.lineNumber !== undefined &&
					numberedLine.lineNumber >= range.startLine &&
					(range.endLine === undefined ||
						numberedLine.lineNumber <= range.endLine)
			);
		const nextLastDisplayedLine = numberedLine.lineNumber ?? lastDisplayedLine;
		const nextLastSelectedLine = isSelectedLine
			? numberedLine.lineNumber
			: lastSelectedLine;
		const remainingRanges = continuationRangesAfter(
			selectedRanges,
			displayRanges,
			nextLastSelectedLine,
			nextLastDisplayedLine,
			lines.length
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
		if (
			acceptedBytes + separatorBytes + lineBytes + noticeBytes >
			maxOutputBytes
		) {
			failedLine = numberedLine;
			break;
		}
		acceptedLines.push(numberedLine.text);
		acceptedBytes += separatorBytes + lineBytes;
		lastDisplayedLine = nextLastDisplayedLine;
		lastSelectedLine = nextLastSelectedLine;
	}
	if (acceptedLines.length === 0) {
		const failedLineBytes = Buffer.byteLength(failedLine?.text ?? "", "utf8");
		if (
			failedLine?.lineNumber !== undefined &&
			failedLineBytes > maxOutputBytes
		) {
			throw new Error(
				`Line ${failedLine.lineNumber} exceeds the ${maxOutputBytes}-byte read limit`
			);
		}
		throw new Error(
			`The first output line cannot fit with its continuation notice within the ${maxOutputBytes}-byte read limit`
		);
	}
	const remainingRanges = continuationRangesAfter(
		selectedRanges,
		displayRanges,
		lastSelectedLine,
		lastDisplayedLine,
		lines.length
	);
	return {
		content: `${acceptedLines.join("\n")}\n\n${continuationNotice(
			filePath,
			remainingRanges,
			maxOutputBytes
		)}`,
		truncated: true,
	};
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

export const runReadTool = async (
	input: ReadInput,
	options: ReadToolOptions = {}
): Promise<ReadOutput> => {
	const target = await readTextTarget(
		input.path,
		options.allowExternalPath === true
	);
	const limits = options.resourceLimits ?? getToolResourceLimits();
	const numberedContent = formatNumberedContent(
		target.content,
		target.path,
		target.ranges,
		limits.read.maxOutputBytes
	);
	return {
		content: numberedContent.content,
		path: target.path,
		...(numberedContent.truncated ? { truncated: true } : {}),
	};
};

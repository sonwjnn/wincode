import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultWorkspaceSandbox } from "../../workspace";
import type { ReadInput, ReadOutput } from "./schema";
import {
	type LineRange,
	normalizeLineRanges,
	splitLineRangeSelector,
} from "./selector";

const READ_CONTENT_MAX_BYTES = 6000;
const RANGE_LEADING_CONTEXT_LINES = 1;
const RANGE_TRAILING_CONTEXT_LINES = 3;
type ResolvedReadTarget = {
	content: string;
	path: string;
	ranges?: LineRange[];
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
		const resolvedPath = await resolvePath(inputPath);
		return {
			content: await readFile(resolvedPath, "utf8"),
			path: inputPath,
		};
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
	ranges: readonly LineRange[]
): string => {
	const selector = ranges
		.map((range) =>
			range.endLine === undefined
				? `${range.startLine}-`
				: `${range.startLine}-${range.endLine}`
		)
		.join(",");
	return `[Output capped at ${READ_CONTENT_MAX_BYTES} bytes. Continue with path \`${filePath}:${selector}\`.]`;
};

const buildNumberedLines = (
	lines: readonly string[],
	selectedRanges: readonly LineRange[]
): NumberedLine[] => {
	const displayRanges = normalizeLineRanges(
		selectedRanges.map((range) => ({
			endLine: Math.min(
				lines.length,
				(range.endLine ?? lines.length) + RANGE_TRAILING_CONTEXT_LINES
			),
			startLine: Math.max(1, range.startLine - RANGE_LEADING_CONTEXT_LINES),
		}))
	);
	const numberedLines: NumberedLine[] = [];
	for (const [rangeIndex, range] of displayRanges.entries()) {
		if (rangeIndex > 0) {
			numberedLines.push({ text: "…" });
		}
		for (
			let lineNumber = range.startLine;
			lineNumber <= (range.endLine ?? lines.length);
			lineNumber += 1
		) {
			numberedLines.push({
				lineNumber,
				text: `${lineNumber}:${lines[lineNumber - 1]}`,
			});
		}
	}
	return numberedLines;
};

const boundNumberedLines = (
	numberedLines: readonly NumberedLine[],
	selectedRanges: readonly LineRange[],
	filePath: string,
	totalLines: number
): NumberedContent => {
	const completeContent = numberedLines.map(({ text }) => text).join("\n");
	if (Buffer.byteLength(completeContent, "utf8") <= READ_CONTENT_MAX_BYTES) {
		return { content: completeContent, truncated: false };
	}
	const acceptedLines: string[] = [];
	let acceptedBytes = 0;
	let lastSelectedLine: number | undefined;
	for (const numberedLine of numberedLines) {
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
		const nextLastSelectedLine = isSelectedLine
			? numberedLine.lineNumber
			: lastSelectedLine;
		const remainingRanges = remainingRangesAfter(
			selectedRanges,
			nextLastSelectedLine,
			totalLines
		);
		const noticeBytes =
			remainingRanges.length === 0
				? 0
				: Buffer.byteLength(
						`\n\n${continuationNotice(filePath, remainingRanges)}`,
						"utf8"
					);
		if (
			acceptedBytes + separatorBytes + lineBytes + noticeBytes >
			READ_CONTENT_MAX_BYTES
		) {
			break;
		}
		acceptedLines.push(numberedLine.text);
		acceptedBytes += separatorBytes + lineBytes;
		lastSelectedLine = nextLastSelectedLine;
	}
	if (acceptedLines.length === 0) {
		throw new Error(
			`The first selected line exceeds the ${READ_CONTENT_MAX_BYTES}-byte read limit`
		);
	}
	const remainingRanges = remainingRangesAfter(
		selectedRanges,
		lastSelectedLine,
		totalLines
	);
	if (remainingRanges.length === 0) {
		return { content: acceptedLines.join("\n"), truncated: false };
	}
	return {
		content: `${acceptedLines.join("\n")}\n\n${continuationNotice(
			filePath,
			remainingRanges
		)}`,
		truncated: true,
	};
};

const formatNumberedContent = (
	content: string,
	filePath: string,
	ranges?: readonly LineRange[]
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
	return boundNumberedLines(
		buildNumberedLines(lines, selectedRanges),
		selectedRanges,
		filePath,
		lines.length
	);
};

export const runReadTool = async (
	input: ReadInput,
	options: { allowExternalPath?: boolean } = {}
): Promise<ReadOutput> => {
	const target = await readTextTarget(
		input.path,
		options.allowExternalPath === true
	);
	const numberedContent = formatNumberedContent(
		target.content,
		target.path,
		target.ranges
	);
	return {
		content: numberedContent.content,
		path: target.path,
		...(numberedContent.truncated ? { truncated: true } : {}),
	};
};

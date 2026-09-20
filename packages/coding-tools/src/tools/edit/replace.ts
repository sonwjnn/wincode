import {
	CodingToolError,
	type VersionedEditingContext,
} from "../../versioned/contracts";
import {
	parseUtf8Content,
	readVersionedFile,
} from "../../versioned/filesystem";
import {
	type LineRange,
	type LosslessText,
	lineRangeForLines,
} from "../../versioned/model";
import type { ToolResourceLimits } from "../resource-limits";
import type { EditInput, EditOutput } from "./schema";
import {
	commitMutation,
	type EditOptions,
	resolveAuthorizedTextPath,
} from "./verified";

const REPLACEMENT_LINE_PATTERN = /\r\n?|\n/u;

type NormalizedText = Readonly<{
	normalized: string;
	sourceOffsets: readonly number[];
}>;

const normalizeLineEndings = (value: string): NormalizedText => {
	let normalized = "";
	const sourceOffsets = [0];
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index] as string;
		if (character === "\r") {
			if (value[index + 1] === "\n") {
				index += 1;
			}
			normalized += "\n";
			sourceOffsets.push(index + 1);
			continue;
		}
		normalized += character;
		sourceOffsets.push(index + 1);
	}
	return { normalized, sourceOffsets };
};

type ReplacementSpan = Readonly<{
	endLine: number;
	newLineCount: number;
	startLine: number;
}>;

type LineOffsetIndex = Readonly<{
	endLineAtOffset: (offset: number) => number;
	startLineAtOffset: (offset: number) => number;
}>;

const createLineOffsetIndex = (text: LosslessText): LineOffsetIndex => {
	const starts: number[] = [];
	let offset = 0;
	for (const line of text.lines) {
		starts.push(offset);
		offset += line.text.length + line.ending.length;
	}
	if (starts.length === 0) {
		starts.push(0);
	}
	const startLineAtOffset = (value: number): number => {
		let lower = 0;
		let upper = starts.length;
		while (lower + 1 < upper) {
			const middle = Math.floor((lower + upper) / 2);
			if ((starts[middle] as number) <= value) {
				lower = middle;
			} else {
				upper = middle;
			}
		}
		return lower + 1;
	};
	return {
		endLineAtOffset: (value) => {
			if (value <= 0) {
				return 1;
			}
			const line = startLineAtOffset(value);
			return line > 1 && starts[line - 1] === value ? line - 1 : line;
		},
		startLineAtOffset,
	};
};

const endsWithLineEnding = (value: string): boolean =>
	value.endsWith("\n") || value.endsWith("\r");

const replacementLineCount = (value: string): number => {
	if (value.length === 0) {
		return 0;
	}
	const lineCount = value.split(REPLACEMENT_LINE_PATTERN).length;
	return endsWithLineEnding(value) ? lineCount - 1 : lineCount;
};

const mapObservedLinesThroughReplacements = (
	observed: readonly LineRange[],
	spans: readonly ReplacementSpan[]
): LineRange[] => {
	let lines: number[] = [];
	for (const range of observed) {
		const endLine = range.endLine ?? range.startLine;
		for (let line = range.startLine; line <= endLine; line += 1) {
			lines.push(line);
		}
	}
	let lineOffset = 0;
	for (const span of spans) {
		const startLine = span.startLine + lineOffset;
		const endLine = span.endLine + lineOffset;
		const delta = span.newLineCount - (span.endLine - span.startLine + 1);
		const nextLines: number[] = [];
		for (const line of lines) {
			if (line < startLine) {
				nextLines.push(line);
			} else if (line > endLine) {
				nextLines.push(line + delta);
			}
		}
		lines = nextLines;
		lineOffset += delta;
	}
	return lineRangeForLines(lines);
};

const findNormalizedMatches = (source: string, target: string): number[] => {
	const matches: number[] = [];
	let searchFrom = 0;
	while (true) {
		const index = source.indexOf(target, searchFrom);
		if (index < 0) {
			return matches;
		}
		matches.push(index);
		searchFrom = index + 1;
	}
};

const selectReplacementMatches = (
	matches: readonly number[],
	targetLength: number,
	replaceAll: boolean
): number[] => {
	if (!replaceAll) {
		return [matches[0] as number];
	}
	const selected: number[] = [];
	for (const match of matches) {
		const previous = selected.at(-1);
		if (previous === undefined || match >= previous + targetLength) {
			selected.push(match);
		}
	}
	return selected;
};

type TextContentSpan = Readonly<{
	end: number;
	start: number;
}>;

const contentSpansForText = (text: LosslessText): TextContentSpan[] => {
	const spans: TextContentSpan[] = [];
	let offset = 0;
	for (const line of text.lines) {
		const end = offset + line.text.length;
		spans.push({ end, start: offset });
		offset = end + line.ending.length;
	}
	return spans;
};

export const runReplaceEdit = async (
	input: Extract<EditInput, { mode: "replace" }>,
	options: EditOptions,
	context: VersionedEditingContext,
	limits: ToolResourceLimits
): Promise<EditOutput> => {
	if (input.oldString.length === 0) {
		throw new CodingToolError(
			"empty-replacement-target",
			"Replace target cannot be empty.",
			{ recovery: { action: "correct-input", path: input.path } }
		);
	}
	if (input.oldString === input.newString) {
		throw new CodingToolError(
			"no-op-edit",
			"Replace target and replacement are identical.",
			{ recovery: { action: "correct-input", path: input.path } }
		);
	}
	const resolvedPath = await resolveAuthorizedTextPath(
		input.path,
		options,
		options.allowExternalPath === true
	);
	const state = await readVersionedFile(resolvedPath);
	const oldObservation = await context.store.getObservation(
		context.sessionId,
		resolvedPath,
		state.fileVersion
	);
	const body = state.text.lines
		.map((line) => `${line.text}${line.ending}`)
		.join("");
	const source = normalizeLineEndings(body);
	const sourceLineOffsets = createLineOffsetIndex(state.text);
	const normalizedTarget = normalizeLineEndings(input.oldString).normalized;
	const matches = findNormalizedMatches(source.normalized, normalizedTarget);
	if (matches.length === 0) {
		throw new CodingToolError(
			"replacement-not-found",
			`Could not find text in ${input.path}.`,
			{
				recovery: { action: "reread", path: input.path },
			}
		);
	}
	if (!input.replaceAll && matches.length !== 1) {
		throw new CodingToolError(
			"replacement-ambiguous",
			`Replace target occurs ${matches.length} times; set replaceAll explicitly or provide a unique target.`,
			{ recovery: { action: "correct-input", path: input.path } }
		);
	}
	const selectedMatches = selectReplacementMatches(
		matches,
		normalizedTarget.length,
		input.replaceAll === true
	);
	let nextBody = "";
	let sourceOffset = 0;
	const replacementOutputSpans: TextContentSpan[] = [];
	const replacementSpans: ReplacementSpan[] = [];
	for (const match of selectedMatches) {
		const start = source.sourceOffsets[match] as number;
		const end = source.sourceOffsets[match + normalizedTarget.length] as number;
		const sourceEndLine = sourceLineOffsets.endLineAtOffset(end);
		const endsAtLineStart =
			end < body.length &&
			sourceLineOffsets.startLineAtOffset(end) > sourceEndLine;
		const endLine =
			sourceEndLine +
			(endsAtLineStart && !endsWithLineEnding(input.newString) ? 1 : 0);
		replacementSpans.push({
			endLine,
			newLineCount: replacementLineCount(input.newString),
			startLine: sourceLineOffsets.startLineAtOffset(start),
		});
		nextBody += body.slice(sourceOffset, start);
		const outputStart = nextBody.length;
		nextBody += input.newString;
		replacementOutputSpans.push({
			end: nextBody.length,
			start: outputStart,
		});
		sourceOffset = end;
	}
	nextBody += body.slice(sourceOffset);
	const nextState = parseUtf8Content(
		state.text.hasBom ? `\ufeff${nextBody}` : nextBody
	);
	if (nextState.fileVersion === state.fileVersion) {
		throw new CodingToolError(
			"no-op-edit",
			`Replace produced no changes: ${input.path}.`,
			{ recovery: { action: "correct-input", path: input.path } }
		);
	}
	const nextLineOffsets = createLineOffsetIndex(nextState.text);
	const replacementLines = replacementLineCount(input.newString);
	const nextContentSpans = contentSpansForText(nextState.text);
	const authoredLineNumbers = new Set<number>();
	for (const span of replacementOutputSpans) {
		const startLine = nextLineOffsets.startLineAtOffset(span.start);
		for (let line = startLine; line < startLine + replacementLines; line += 1) {
			const contentSpan = nextContentSpans[line - 1];
			if (
				contentSpan &&
				contentSpan.start >= span.start &&
				contentSpan.end <= span.end
			) {
				authoredLineNumbers.add(line);
			}
		}
	}
	const authoredSeenLines = lineRangeForLines(
		[...authoredLineNumbers].sort((a, b) => a - b)
	);
	const preservedSeenLines = oldObservation
		? mapObservedLinesThroughReplacements(
				oldObservation.seenLines,
				replacementSpans
			)
		: [];
	const seenLines = [...preservedSeenLines, ...authoredSeenLines];
	return commitMutation({
		context,
		limits,
		newState: nextState,
		oldState: state,
		pathName: input.path,
		resolvedPath,
		seenLines,
		replacements: selectedMatches.length,
	});
};

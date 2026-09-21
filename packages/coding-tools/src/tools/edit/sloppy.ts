import { omitUndefined } from "@wincode/runtime-utils";
import {
	CodingToolError,
	type VersionedEditingContext,
} from "../../versioned/contracts";
import { readVersionedFile } from "../../versioned/filesystem";
import {
	type LineRange,
	type LosslessTextLine,
	lineRangeForLines,
} from "../../versioned/model";
import type { ToolResourceLimits } from "../resource-limits";
import type { EditInput, EditOutput } from "./schema";
import {
	applyLineHunk,
	commitMutation,
	type EditOptions,
	resolveAuthorizedTextPath,
	stateFromText,
} from "./verified";

type SloppyContextPosition = Readonly<{
	newIndex: number;
	oldIndex: number;
}>;

type SloppyHunk = Readonly<{
	context: readonly string[];
	contextPositions: readonly SloppyContextPosition[];
	hint?: number;
	oldLines: readonly string[];
	newLines: readonly string[];
}>;

type SloppyPatch = Readonly<{
	hunks: readonly SloppyHunk[];
	path: string;
}>;

type ResolvedSloppyHunk = Readonly<{
	hunk: SloppyHunk;
	startIndex: number;
}>;

const SLOPPY_UPDATE_PATTERN = /^\*\*\* Update File: (.+)$/u;
const SLOPPY_HINT_PATTERN = /^@@(?: -([1-9]\d*))?/u;

const hasControlCharacter = (value: string): boolean => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
};

const patchLines = (patch: string): string[] => {
	const lines = patch.replace(/\r\n?/gu, "\n").split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

const normalizedText = (value: string): string =>
	value.normalize("NFKC").replace(/\s+/gu, " ").trim();

const normalizedLineMatches = (
	lines: readonly string[],
	needle: readonly string[]
): number[] => {
	const target = needle.map(normalizedText);
	const matches: number[] = [];
	for (let index = 0; index + target.length <= lines.length; index += 1) {
		if (
			target.every(
				(line, offset) =>
					normalizedText(lines[index + offset] as string) === line
			)
		) {
			matches.push(index);
		}
	}
	return matches;
};

const sloppyContentLine = (line: string): string => {
	const value = line.slice(1);
	if (value.includes("\0")) {
		throw new CodingToolError(
			"binary-content",
			"Sloppy edit content cannot contain NUL characters.",
			{ recovery: { action: "correct-input" } }
		);
	}
	return value;
};

const parseSloppyPatch = (patch: string): SloppyPatch => {
	const lines = patchLines(patch);
	if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
		throw new CodingToolError(
			"invalid-sloppy-patch",
			"Sloppy mode requires a Begin Patch and End Patch envelope.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const updateIndex = lines.findIndex((line) =>
		SLOPPY_UPDATE_PATTERN.test(line)
	);
	if (updateIndex < 0) {
		throw new CodingToolError(
			"invalid-sloppy-patch",
			"Sloppy mode requires one Update File header.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const headerMatch = SLOPPY_UPDATE_PATTERN.exec(lines[updateIndex] as string);
	const pathName = headerMatch?.[1];
	if (pathName === undefined) {
		throw new CodingToolError(
			"invalid-sloppy-patch",
			"Update File path is missing."
		);
	}
	if (hasControlCharacter(pathName)) {
		throw new CodingToolError(
			"invalid-sloppy-patch",
			"Update File paths cannot contain control characters.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const hunks: SloppyHunk[] = [];
	let currentOld: string[] = [];
	let currentNew: string[] = [];
	let contextLines: string[] = [];
	let contextPositions: SloppyContextPosition[] = [];
	let hint: number | undefined;
	const flush = (): void => {
		if (currentOld.length === 0 && currentNew.length === 0) {
			return;
		}
		hunks.push({
			context: contextLines,
			contextPositions,
			...omitUndefined({ hint }),
			newLines: currentNew,
			oldLines: currentOld,
		});
		currentOld = [];
		currentNew = [];
		contextLines = [];
		contextPositions = [];
		hint = undefined;
	};
	for (const line of lines.slice(updateIndex + 1, -1)) {
		if (line.startsWith("@@")) {
			flush();
			const match = SLOPPY_HINT_PATTERN.exec(line);
			hint = match?.[1] === undefined ? undefined : Number(match[1]);
			continue;
		}
		if (line.startsWith(" ")) {
			const value = sloppyContentLine(line);
			const oldIndex = currentOld.length;
			const newIndex = currentNew.length;
			currentOld.push(value);
			currentNew.push(value);
			contextLines.push(value);
			contextPositions.push({ newIndex, oldIndex });
			continue;
		}
		if (line.startsWith("-")) {
			currentOld.push(sloppyContentLine(line));
			continue;
		}
		if (line.startsWith("+")) {
			currentNew.push(sloppyContentLine(line));
			continue;
		}
		throw new CodingToolError(
			"invalid-sloppy-patch",
			"Sloppy patch lines must be context, removal, addition, or hunk hints.",
			{ recovery: { action: "correct-input" } }
		);
	}
	flush();
	if (hunks.length === 0 || hunks.some((hunk) => hunk.oldLines.length === 0)) {
		throw new CodingToolError(
			"invalid-sloppy-patch",
			"Sloppy mode requires one non-empty context or removal hunk.",
			{ recovery: { action: "correct-input" } }
		);
	}
	return { hunks, path: pathName };
};

const exactLineMatches = (
	lines: readonly string[],
	needle: readonly string[]
): number[] => {
	const matches: number[] = [];
	for (let index = 0; index + needle.length <= lines.length; index += 1) {
		if (needle.every((line, offset) => lines[index + offset] === line)) {
			matches.push(index);
		}
	}
	return matches;
};
const orderSloppyMatches = (
	matches: readonly number[],
	hint: number | undefined
): number[] =>
	hint === undefined
		? [...matches]
		: [...matches].toSorted(
				(left, right) => Math.abs(left + 1 - hint) - Math.abs(right + 1 - hint)
			);

const anchorSimilarityMatches = (
	lines: readonly string[],
	hunk: SloppyHunk
): number[] => {
	if (hunk.contextPositions.length === 0) {
		return [];
	}
	const target = hunk.oldLines.map(normalizedText);
	const anchors = hunk.context.map(normalizedText);
	const minimumScore = Math.max(
		hunk.contextPositions.length,
		Math.ceil(target.length / 2)
	);
	const matches: number[] = [];
	for (let index = 0; index + target.length <= lines.length; index += 1) {
		const candidate = lines
			.slice(index, index + target.length)
			.map(normalizedText);
		const anchorsMatch = hunk.contextPositions.every(
			({ oldIndex }, contextIndex) =>
				candidate[oldIndex] === anchors[contextIndex]
		);
		if (!anchorsMatch) {
			continue;
		}
		const score = target.reduce(
			(total, line, offset) => total + (candidate[offset] === line ? 1 : 0),
			0
		);
		if (score >= minimumScore) {
			matches.push(index);
		}
	}
	return matches;
};

const sloppyLineMatches = (
	lines: readonly string[],
	hunk: SloppyHunk
): number[] => {
	const exact = orderSloppyMatches(
		exactLineMatches(lines, hunk.oldLines),
		hunk.hint
	);
	if (exact.length > 0) {
		return exact;
	}
	const normalized = orderSloppyMatches(
		normalizedLineMatches(lines, hunk.oldLines),
		hunk.hint
	);
	return normalized.length > 0
		? normalized
		: orderSloppyMatches(anchorSimilarityMatches(lines, hunk), hunk.hint);
};

const resolveSloppyHunks = (
	lines: readonly LosslessTextLine[],
	hunks: readonly SloppyHunk[],
	pathName: string,
	maxRecoveryComparisons: number
): ResolvedSloppyHunk[] => {
	const lineTexts = lines.map((line) => line.text);
	let totalComparisons = 0;
	for (const hunk of hunks) {
		totalComparisons +=
			Math.max(1, hunk.oldLines.length) * lineTexts.length * 3;
		if (totalComparisons > maxRecoveryComparisons) {
			const lineRange =
				hunk.hint === undefined
					? { endLine: lineTexts.length, startLine: 1 }
					: {
							endLine: hunk.hint + hunk.oldLines.length - 1,
							startLine: hunk.hint,
						};
			throw new CodingToolError(
				"recovery-out-of-budget",
				"Sloppy recovery exceeded its comparison budget. Read the file again.",
				{
					details: {
						lineRange,
						maxComparisons: maxRecoveryComparisons,
						path: pathName,
					},
					recovery: { action: "reread", lineRange, path: pathName },
				}
			);
		}
	}
	const resolved = hunks.map((hunk) => {
		const candidates = sloppyLineMatches(lineTexts, hunk);
		if (candidates.length !== 1) {
			throw new CodingToolError(
				candidates.length === 0 ? "sloppy-no-match" : "sloppy-ambiguous",
				candidates.length === 0
					? "Sloppy patch context did not match the live file."
					: "Sloppy patch context matched more than one live region.",
				{ recovery: { action: "reread", path: pathName } }
			);
		}
		return { hunk, startIndex: candidates[0] as number };
	});
	const ordered = [...resolved].sort(
		(left, right) => left.startIndex - right.startIndex
	);
	for (let index = 1; index < ordered.length; index += 1) {
		const previous = ordered[index - 1] as ResolvedSloppyHunk;
		const current = ordered[index] as ResolvedSloppyHunk;
		if (
			current.startIndex <
			previous.startIndex + previous.hunk.oldLines.length
		) {
			throw new CodingToolError(
				"sloppy-overlap",
				"Sloppy patch hunks overlap in the live file.",
				{ recovery: { action: "reread", path: pathName } }
			);
		}
	}
	return ordered;
};

export const runSloppyEdit = async (
	input: Extract<EditInput, { mode: "sloppy" }>,
	options: EditOptions,
	context: VersionedEditingContext,
	limits: ToolResourceLimits
): Promise<EditOutput> => {
	if (options.allowSloppy !== true) {
		throw new CodingToolError(
			"sloppy-permission-required",
			"Sloppy editing requires the separate edit:sloppy permission.",
			{ recovery: { action: "grant-sloppy" } }
		);
	}
	const patch = parseSloppyPatch(input.patch);
	const resolvedPath = await resolveAuthorizedTextPath(
		patch.path,
		options,
		options.allowExternalPath === true
	);
	const state = await readVersionedFile(resolvedPath);
	const oldObservation = await context.store.getObservation(
		context.sessionId,
		resolvedPath,
		state.fileVersion
	);
	const resolvedHunks = resolveSloppyHunks(
		state.text.lines,
		patch.hunks,
		patch.path,
		limits.edit.maxRecoveryComparisons
	);
	let nextText = state.text;
	const seen = new Set<number>();
	let lineOffset = 0;
	for (const resolved of resolvedHunks) {
		const startLine = resolved.startIndex + 1 + lineOffset;
		const contextIndexes = new Set(
			resolved.hunk.contextPositions.map(({ newIndex }) => newIndex)
		);
		for (let index = 0; index < resolved.hunk.newLines.length; index += 1) {
			if (!contextIndexes.has(index)) {
				seen.add(startLine + index);
			}
		}
		lineOffset += resolved.hunk.newLines.length - resolved.hunk.oldLines.length;
	}
	for (const resolved of [...resolvedHunks].reverse()) {
		const startLine = resolved.startIndex + 1;
		const liveLines = nextText.lines.slice(
			startLine - 1,
			startLine - 1 + resolved.hunk.oldLines.length
		);
		const contextByNewIndex = new Map(
			resolved.hunk.contextPositions.map(({ newIndex, oldIndex }) => [
				newIndex,
				oldIndex,
			])
		);
		const body = resolved.hunk.newLines.map((value, index) => {
			const oldIndex = contextByNewIndex.get(index);
			return oldIndex === undefined
				? value
				: (liveLines[oldIndex]?.text ?? value);
		});
		const candidateText = applyLineHunk(nextText, {
			body,
			endLine: startLine + resolved.hunk.oldLines.length - 1,
			kind: "replace",
			startLine,
		});
		if (
			stateFromText(candidateText).fileVersion ===
			stateFromText(nextText).fileVersion
		) {
			throw new CodingToolError(
				"no-op-edit",
				"Sloppy edit hunk produced no changes.",
				{
					recovery: { action: "correct-input", path: patch.path },
				}
			);
		}
		nextText = candidateText;
	}
	const nextState = stateFromText(nextText);
	if (nextState.fileVersion === state.fileVersion) {
		throw new CodingToolError(
			"no-op-edit",
			"Sloppy edit produced no changes.",
			{
				recovery: { action: "correct-input", path: patch.path },
			}
		);
	}
	const preservedSeenLines =
		oldObservation === null
			? []
			: mapObservedLinesThroughSloppyHunks(
					oldObservation.seenLines,
					resolvedHunks
				);
	return commitMutation({
		context,
		limits,
		newState: nextState,
		oldState: state,
		pathName: patch.path,
		resolvedPath,
		seenLines: [
			...preservedSeenLines,
			...lineRangeForLines([...seen].sort((left, right) => left - right)),
		],
		replacements: resolvedHunks.length,
	});
};

const mapObservedLinesThroughSloppyHunks = (
	observed: readonly LineRange[],
	hunks: readonly ResolvedSloppyHunk[]
): LineRange[] => {
	let lines: number[] = [];
	for (const range of observed) {
		const endLine = range.endLine ?? range.startLine;
		for (let line = range.startLine; line <= endLine; line += 1) {
			lines.push(line);
		}
	}
	let lineOffset = 0;
	for (const { hunk, startIndex } of hunks) {
		const startLine = startIndex + 1 + lineOffset;
		const endLine = startLine + hunk.oldLines.length - 1;
		const contextByOldIndex = new Map(
			hunk.contextPositions.map(({ oldIndex, newIndex }) => [
				oldIndex,
				newIndex,
			])
		);
		const delta = hunk.newLines.length - hunk.oldLines.length;
		const nextLines: number[] = [];
		for (const line of lines) {
			if (line < startLine) {
				nextLines.push(line);
			} else if (line > endLine) {
				nextLines.push(line + delta);
			} else {
				const newIndex = contextByOldIndex.get(line - startLine);
				if (newIndex !== undefined) {
					nextLines.push(startLine + newIndex);
				}
			}
		}
		lines = nextLines;
		lineOffset += delta;
	}
	return lineRangeForLines(lines);
};

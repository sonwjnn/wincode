import { diffArrays } from "diff";
import {
	CodingToolError,
	defaultVersionedEditingContext,
	type FileSnapshot,
	isCodingToolError,
	type VersionedEditingContext,
} from "../../versioned/contracts";
import {
	atomicReplaceFile,
	expectFileVersion,
	type FileState,
	parseUtf8Content,
	persistFileObservation,
	readVersionedFile,
	resolveExistingTextPath,
	withFileMutationLock,
	withSnapshotFailureCleanup,
} from "../../versioned/filesystem";
import {
	byteLength,
	computeFileVersion,
	decodeLosslessText,
	encodeLosslessText,
	type FileVersion,
	type LineEnding,
	type LineRange,
	type LosslessText,
	type LosslessTextLine,
	lineRangeForLines,
	lineRangesContain,
} from "../../versioned/model";
import { decodeEscapedPatchPath } from "../../versioned/patch";
import {
	getToolResourceLimits,
	type ResourceLimitOptions,
	type ToolResourceLimits,
} from "../resource-limits";
import { buildEditDiff } from "./diff";
import type { EditInput, EditOutput } from "./schema";

type EditOptions = ResourceLimitOptions & {
	allowSloppy?: boolean;
	versionedEditing?: VersionedEditingContext;
};

type ParsedSection = Readonly<{
	hunks: readonly ParsedHunk[];
	path: string;
	version: FileVersion;
}>;

type ParsedHunk = Readonly<{
	body: readonly string[];
	endLine?: number;
	kind: "cut" | "insert-after" | "insert-before" | "replace";
	startLine: number;
}>;

type PositionedHunk = ParsedHunk &
	Readonly<{
		endLine: number;
		startLine: number;
	}>;

type SloppyPatch = Readonly<{
	hunks: readonly SloppyHunk[];
	path: string;
}>;

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

const PATCH_HEADER_PATTERN = /^\[(.*)\]$/u;
const VERSION_SUFFIX_LENGTH = 33;
const OPERATION_PATTERN =
	/^(?:PUT (?:([1-9]\d*)\.=(\d+)|<([1-9]\d*)|>([1-9]\d*)):|CUT ([1-9]\d*)\.=(\d+))$/u;
const SLOPPY_UPDATE_PATTERN = /^\*\*\* Update File: (.+)$/u;
const hasControlCharacter = (value: string): boolean => {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
};
const FILE_VERSION_PATTERN = /^[0-9a-f]{32}$/u;
const LINE_NUMBER_PATTERN = /^[1-9]\d*$/u;
const REPLACEMENT_LINE_PATTERN = /\r\n?|\n/u;
const SLOPPY_HINT_PATTERN = /^@@(?: -([1-9]\d*))?/u;

const decodePatchPath = (encoded: string): string => {
	const decoded = decodeEscapedPatchPath(encoded);
	if (decoded !== undefined) {
		return decoded;
	}
	throw new CodingToolError(
		"invalid-patch",
		"Patch paths must be non-empty and escape only closing brackets and backslashes.",
		{ recovery: { action: "correct-input" } }
	);
};

const parseSectionHeader = (
	line: string
): {
	path: string;
	version: FileVersion;
} => {
	const match = PATCH_HEADER_PATTERN.exec(line);
	if (!match) {
		throw new CodingToolError(
			"invalid-patch",
			"A verified patch must begin with [encoded-path#file-version].",
			{ recovery: { action: "correct-input" } }
		);
	}
	const inner = match[1] as string;
	if (inner.length <= VERSION_SUFFIX_LENGTH) {
		throw new CodingToolError(
			"invalid-patch",
			"A verified patch header must include a path and 128-bit File Version.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const versionStart = inner.length - VERSION_SUFFIX_LENGTH;
	if (inner[versionStart] !== "#") {
		throw new CodingToolError(
			"invalid-patch",
			"A verified patch header must end with # followed by 32 lowercase hex characters.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const versionText = inner.slice(versionStart + 1);
	if (!FILE_VERSION_PATTERN.test(versionText)) {
		throw new CodingToolError(
			"invalid-patch",
			"A verified patch header must end with a lowercase 128-bit File Version.",
			{ recovery: { action: "correct-input" } }
		);
	}
	return {
		path: decodePatchPath(inner.slice(0, versionStart)),
		version: versionText as FileVersion,
	};
};

const patchLines = (patch: string): string[] => {
	const lines = patch.replace(/\r\n?/gu, "\n").split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

const parseLineNumber = (value: string, label: string): number => {
	if (!LINE_NUMBER_PATTERN.test(value)) {
		throw new CodingToolError(
			"invalid-patch",
			`${label} must be a positive decimal line number without leading zeros.`,
			{ recovery: { action: "correct-input" } }
		);
	}
	return Number(value);
};

const replacementBody = (lines: readonly string[]): string[] => {
	const body: string[] = [];
	for (const line of lines) {
		if (!line.startsWith("+")) {
			throw new CodingToolError(
				"invalid-patch",
				"Replacement lines must begin with exactly one protocol plus prefix.",
				{ recovery: { action: "correct-input" } }
			);
		}
		const value = line.slice(1);
		if (value.includes("\0")) {
			throw new CodingToolError(
				"binary-content",
				"Edit content cannot contain NUL characters.",
				{ recovery: { action: "correct-input" } }
			);
		}
		body.push(value);
	}
	if (body.length === 0) {
		throw new CodingToolError(
			"invalid-patch",
			"An empty replacement must use CUT rather than an empty PUT body.",
			{ recovery: { action: "correct-input" } }
		);
	}
	return body;
};

type ParsedOperation = Omit<ParsedHunk, "body">;

const parseVerifiedOperation = (operation: string): ParsedOperation => {
	const match = OPERATION_PATTERN.exec(operation);
	if (!match) {
		throw new CodingToolError(
			"invalid-patch",
			`Invalid verified patch operation '${operation}'.`,
			{ recovery: { action: "correct-input" } }
		);
	}
	const putStart = match[1];
	const putEnd = match[2];
	const beforeLine = match[3];
	const afterLine = match[4];
	const cutStart = match[5];
	const cutEnd = match[6];
	if (cutStart !== undefined && cutEnd !== undefined) {
		const startLine = parseLineNumber(cutStart, "CUT start");
		const endLine = parseLineNumber(cutEnd, "CUT end");
		if (endLine < startLine) {
			throw new CodingToolError(
				"invalid-patch",
				"CUT ranges must be ordered.",
				{ recovery: { action: "correct-input" } }
			);
		}
		return { endLine, kind: "cut", startLine };
	}
	if (putStart !== undefined && putEnd !== undefined) {
		const startLine = parseLineNumber(putStart, "PUT start");
		const endLine = parseLineNumber(putEnd, "PUT end");
		if (endLine < startLine) {
			throw new CodingToolError(
				"invalid-patch",
				"PUT ranges must be ordered.",
				{ recovery: { action: "correct-input" } }
			);
		}
		return { endLine, kind: "replace", startLine };
	}
	if (beforeLine !== undefined) {
		return {
			kind: "insert-before",
			startLine: parseLineNumber(beforeLine, "PUT-before anchor"),
		};
	}
	if (afterLine === undefined) {
		throw new CodingToolError("invalid-patch", "Invalid PUT operation.", {
			recovery: { action: "correct-input" },
		});
	}
	return {
		kind: "insert-after",
		startLine: parseLineNumber(afterLine, "PUT-after anchor"),
	};
};

const patchBodyEnd = (lines: readonly string[], start: number): number => {
	let end = start;
	while (
		end < lines.length &&
		!OPERATION_PATTERN.test(lines[end] as string) &&
		!PATCH_HEADER_PATTERN.test(lines[end] as string)
	) {
		end += 1;
	}
	return end;
};
const parseVerifiedPatch = (patch: string): ParsedSection => {
	const lines = patchLines(patch);
	const header = lines[0];
	if (header === undefined) {
		throw new CodingToolError("invalid-patch", "Patch input is empty.", {
			recovery: { action: "correct-input" },
		});
	}
	const section = parseSectionHeader(header);
	const hunks: ParsedHunk[] = [];
	let index = 1;
	while (index < lines.length) {
		const operation = lines[index];
		if (operation === undefined || operation.length === 0) {
			throw new CodingToolError(
				"invalid-patch",
				"Verified patch operations cannot contain blank lines outside replacement bodies.",
				{ recovery: { action: "correct-input" } }
			);
		}
		const parsedOperation = parseVerifiedOperation(operation);
		if (parsedOperation.kind === "cut") {
			hunks.push({ ...parsedOperation, body: [] });
			index += 1;
			continue;
		}
		const bodyStart = index + 1;
		const bodyEnd = patchBodyEnd(lines, bodyStart);
		hunks.push({
			...parsedOperation,
			body: replacementBody(lines.slice(bodyStart, bodyEnd)),
		});
		index = bodyEnd;
	}
	if (hunks.length === 0) {
		throw new CodingToolError(
			"invalid-patch",
			"Verified patch must contain one line operation.",
			{ recovery: { action: "correct-input" } }
		);
	}
	return { hunks, path: section.path, version: section.version };
};

const visibleLineNumbers = (
	observation: { seenLines: readonly LineRange[] },
	hunk: ParsedHunk
): number[] => {
	const start = hunk.startLine;
	const end = hunk.endLine ?? hunk.startLine;
	const lines: number[] = [];
	for (let line = start; line <= end; line += 1) {
		lines.push(line);
	}
	return lines.filter((line) => lineRangesContain(observation.seenLines, line));
};

const lineRangeForHunk = (hunk: ParsedHunk): LineRange =>
	hunk.endLine === undefined
		? { startLine: hunk.startLine }
		: { endLine: hunk.endLine, startLine: hunk.startLine };

const ensureVisible = (
	observation: { seenLines: readonly LineRange[] } | null,
	hunk: ParsedHunk,
	pathName: string
): { seenLines: readonly LineRange[] } => {
	if (observation === null) {
		throw new CodingToolError(
			"observation-required",
			`No File Observation authorizes '${pathName}'. Read it before editing.`,
			{ recovery: { action: "reread", path: pathName } }
		);
	}
	const required =
		hunk.kind === "replace" || hunk.kind === "cut"
			? visibleLineNumbers(observation, hunk).length ===
				(hunk.endLine as number) - hunk.startLine + 1
			: lineRangesContain(observation.seenLines, hunk.startLine);
	if (!required) {
		const range = lineRangeForHunk(hunk);
		throw new CodingToolError(
			"unseen-lines",
			`Edit target in '${pathName}' includes lines that were not completely observed.`,
			{
				details: { path: pathName, range },
				recovery: { action: "reread", lineRange: range, path: pathName },
			}
		);
	}
	return observation;
};

const sameLosslessLine = (
	left: LosslessTextLine | undefined,
	right: LosslessTextLine | undefined
): boolean =>
	left !== undefined &&
	right !== undefined &&
	left.text === right.text &&
	left.ending === right.ending;

type RecoveryDiffChange = Readonly<{
	added?: boolean;
	count: number;
	removed?: boolean;
}>;
type RecoveryBoundarySide = "after" | "before";

const isRecoveryAddedBoundaryChange = (
	sourceIndex: number,
	targetStart: number,
	targetEnd: number,
	boundarySide: RecoveryBoundarySide | undefined
): boolean => {
	if (sourceIndex > targetStart && sourceIndex < targetEnd) {
		return true;
	}
	return (
		(boundarySide === "before" && sourceIndex === targetStart) ||
		(boundarySide === "after" && sourceIndex === targetEnd)
	);
};

const isRecoveryRemovedBoundaryChange = (
	sourceIndex: number,
	removedEnd: number,
	targetStart: number,
	targetEnd: number
): boolean => sourceIndex < targetEnd && removedEnd > targetStart;
const mapRecoveryDiff = (
	changes: readonly RecoveryDiffChange[],
	targetStart: number,
	targetEnd: number,
	targetLength: number,
	boundarySide?: RecoveryBoundarySide
): {
	boundaryChanged: boolean;
	mappedEnd?: number;
	mappedStart?: number;
} => {
	let sourceIndex = 0;
	let liveIndex = 0;
	let mappedStart: number | undefined;
	let mappedEnd: number | undefined;
	let boundaryChanged = false;
	for (const change of changes) {
		if (change.added) {
			if (
				isRecoveryAddedBoundaryChange(
					sourceIndex,
					targetStart,
					targetEnd,
					boundarySide
				)
			) {
				boundaryChanged = true;
			}
			liveIndex += change.count;
			continue;
		}
		if (change.removed) {
			const removedEnd = sourceIndex + change.count;
			if (
				isRecoveryRemovedBoundaryChange(
					sourceIndex,
					removedEnd,
					targetStart,
					targetEnd
				)
			) {
				boundaryChanged = true;
			}
			sourceIndex = removedEnd;
			continue;
		}
		if (
			mappedStart === undefined &&
			sourceIndex <= targetStart &&
			targetEnd <= sourceIndex + change.count
		) {
			mappedStart = liveIndex + targetStart - sourceIndex;
			mappedEnd = mappedStart + targetLength;
		}
		sourceIndex += change.count;
		liveIndex += change.count;
	}
	return { boundaryChanged, mappedEnd, mappedStart };
};

const findMappedLine = (
	snapshotLines: readonly LosslessTextLine[],
	liveLines: readonly LosslessTextLine[],
	startLine: number,
	endLine: number,
	pathName: string,
	maxComparisons: number,
	boundarySide?: RecoveryBoundarySide
): { endLine: number; startLine: number } => {
	const targetStart = startLine - 1;
	const targetEnd = endLine;
	const target = snapshotLines.slice(targetStart, targetEnd);
	const recoveryRange: LineRange =
		startLine === endLine ? { startLine } : { endLine, startLine };
	if (
		target.length * (liveLines.length + snapshotLines.length) >
		maxComparisons
	) {
		throw new CodingToolError(
			"recovery-out-of-budget",
			"Snapshot recovery exceeded its comparison budget. Read the file again.",
			{
				details: {
					lineRange: recoveryRange,
					maxComparisons,
					path: pathName,
				},
				recovery: {
					action: "reread",
					lineRange: recoveryRange,
					path: pathName,
				},
			}
		);
	}
	if (countLineSequenceMatches(snapshotLines, target) > 1) {
		throw new CodingToolError(
			"ambiguous-recovery",
			"The observed edit target is repeated in the snapshot. Read the file again.",
			{ recovery: { action: "reread", path: pathName } }
		);
	}
	if (countLineSequenceMatches(liveLines, target) !== 1) {
		throw new CodingToolError(
			"stale-edit",
			"The live edit target is missing or ambiguous. Read the file again.",
			{ recovery: { action: "reread", path: pathName } }
		);
	}
	const changes = diffArrays([...snapshotLines], [...liveLines], {
		comparator: sameLosslessLine,
		maxEditLength: maxComparisons,
	});
	if (changes === undefined) {
		throw new CodingToolError(
			"recovery-out-of-budget",
			"Snapshot recovery exceeded its comparison budget. Read the file again.",
			{
				details: {
					lineRange: recoveryRange,
					maxComparisons,
					path: pathName,
				},
				recovery: {
					action: "reread",
					lineRange: recoveryRange,
					path: pathName,
				},
			}
		);
	}
	const mapping = mapRecoveryDiff(
		changes,
		targetStart,
		targetEnd,
		target.length,
		boundarySide
	);
	if (
		mapping.boundaryChanged ||
		mapping.mappedStart === undefined ||
		mapping.mappedEnd === undefined
	) {
		throw new CodingToolError(
			"stale-edit",
			"The live file changed inside the requested edit target or boundary. Read it again.",
			{ recovery: { action: "reread", path: pathName } }
		);
	}
	return {
		endLine: mapping.mappedEnd,
		startLine: mapping.mappedStart + 1,
	};
};

const mapInsertionBoundary = (
	snapshotLines: readonly LosslessTextLine[],
	liveLines: readonly LosslessTextLine[],
	line: number,
	pathName: string,
	maxComparisons: number,
	boundarySide: RecoveryBoundarySide
): number => {
	const mapped = findMappedLine(
		snapshotLines,
		liveLines,
		line,
		line,
		pathName,
		maxComparisons,
		boundarySide
	);
	return mapped.startLine;
};
const defaultLineEnding = (lines: readonly LosslessTextLine[]): LineEnding => {
	const ending = lines.find((line) => line.ending.length > 0)?.ending;
	return ending ?? "\n";
};

const renumberLines = (lines: readonly LosslessTextLine[]): LosslessText => ({
	hasBom: false,
	hasTrailingNewline: (lines.at(-1)?.ending.length ?? 0) > 0,
	lines: lines.map((line, index) => ({ ...line, lineNumber: index + 1 })),
});

const applyLineHunk = (
	text: LosslessText,
	hunk: PositionedHunk
): LosslessText => {
	const lines = [...text.lines];
	const fallbackEnding = defaultLineEnding(lines);
	const hadTrailingNewline = text.hasTrailingNewline;
	const body = hunk.body;
	if (hunk.kind === "replace" || hunk.kind === "cut") {
		const originals = lines.slice(hunk.startLine - 1, hunk.endLine);
		const lastEnding = originals.at(-1)?.ending ?? fallbackEnding;
		const replacement = body.map((value, index) => ({
			ending:
				index === body.length - 1
					? lastEnding
					: originals[index]?.ending || fallbackEnding,
			lineNumber: 0,
			text: value,
		}));
		lines.splice(
			hunk.startLine - 1,
			hunk.endLine - hunk.startLine + 1,
			...replacement
		);
		const nextText = renumberLines(lines);
		if (
			!hadTrailingNewline &&
			body.length === 0 &&
			hunk.endLine === text.lines.length &&
			nextText.lines.length > 0
		) {
			const lastLine = nextText.lines.at(-1) as LosslessTextLine;
			return {
				...nextText,
				hasBom: text.hasBom,
				hasTrailingNewline: false,
				lines: [...nextText.lines.slice(0, -1), { ...lastLine, ending: "" }],
			};
		}
		return { ...nextText, hasBom: text.hasBom };
	}
	const anchorIndex = hunk.startLine - 1;
	if (hunk.kind === "insert-after" && lines[anchorIndex]?.ending === "") {
		lines[anchorIndex] = {
			...lines[anchorIndex],
			ending: fallbackEnding,
		};
	}
	const ending: LosslessTextLine["ending"] =
		lines[anchorIndex]?.ending || fallbackEnding;
	const insertion: LosslessTextLine[] = body.map((value, index) => ({
		ending:
			index === body.length - 1 &&
			hunk.kind === "insert-after" &&
			anchorIndex === lines.length - 1 &&
			!hadTrailingNewline
				? ""
				: ending,
		lineNumber: 0,
		text: value,
	}));
	lines.splice(
		hunk.kind === "insert-after" ? anchorIndex + 1 : anchorIndex,
		0,
		...insertion
	);
	return { ...renumberLines(lines), hasBom: text.hasBom };
};

const textForDiff = (state: FileState): string =>
	new TextDecoder().decode(state.bytes);

const restoreMutationAfterFailure = async ({
	newState,
	oldState,
	resolvedPath,
}: {
	newState: FileState;
	oldState: FileState;
	resolvedPath: string;
}): Promise<boolean> => {
	try {
		const current = await readVersionedFile(resolvedPath);
		if (current.fileVersion !== newState.fileVersion) {
			return false;
		}
		await atomicReplaceFile(resolvedPath, oldState.bytes);
		return true;
	} catch {
		return false;
	}
};

const persistEditObservation = async ({
	context,
	limits,
	newState,
	oldState,
	pathName,
	resolvedPath,
	seenLines,
	snapshotPersisted,
}: {
	context: VersionedEditingContext;
	limits: ToolResourceLimits;
	newState: FileState;
	oldState: FileState;
	pathName: string;
	resolvedPath: string;
	seenLines: readonly LineRange[];
	snapshotPersisted: boolean;
}): Promise<Awaited<ReturnType<typeof persistFileObservation>>> => {
	try {
		return await persistFileObservation({
			context,
			limits,
			path: resolvedPath,
			seenLines,
			snapshotPersisted,
			state: newState,
		});
	} catch (error) {
		const restored = await restoreMutationAfterFailure({
			newState,
			oldState,
			resolvedPath,
		});
		if (!restored) {
			throw new CodingToolError(
				"mutation-persistence-failed",
				"Mutation persistence failed and the file could not be safely restored.",
				{
					details: { path: pathName },
					recovery: { action: "reread", path: pathName },
				}
			);
		}
		if (isCodingToolError(error)) {
			throw error;
		}
		throw new CodingToolError(
			"mutation-persistence-failed",
			"Mutation persistence failed after the file was restored.",
			{
				details: { path: pathName },
				recovery: { action: "reread", path: pathName },
			}
		);
	}
};

const commitMutation = async ({
	context,
	limits,
	newState,
	oldState,
	pathName,
	resolvedPath,
	seenLines,
	replacements = 1,
}: {
	context: VersionedEditingContext;
	limits: ToolResourceLimits;
	newState: FileState;
	oldState: FileState;
	pathName: string;
	resolvedPath: string;
	seenLines: readonly LineRange[];
	replacements?: number;
}): Promise<EditOutput> => {
	const editDiff = buildEditDiff(
		textForDiff(oldState),
		textForDiff(newState),
		pathName,
		limits.edit
	);
	if (editDiff.truncated) {
		throw new CodingToolError(
			"edit-diff-out-of-budget",
			"Edit diff exceeds the configured output budget.",
			{
				details: { omittedHunks: editDiff.omittedHunks },
				recovery: {
					action: "correct-input",
					message:
						"Reduce the requested change or use a larger resource limit.",
				},
			}
		);
	}
	return withFileMutationLock(resolvedPath, () =>
		withSnapshotFailureCleanup(
			context,
			{ fileVersion: newState.fileVersion, path: resolvedPath },
			async () => {
				const latest = await readVersionedFile(resolvedPath);
				expectFileVersion(latest.fileVersion, oldState.fileVersion, pathName);
				const latestBeforeRename = await readVersionedFile(resolvedPath);
				expectFileVersion(
					latestBeforeRename.fileVersion,
					oldState.fileVersion,
					pathName
				);
				await atomicReplaceFile(resolvedPath, newState.bytes);
				const observation = await persistEditObservation({
					context,
					limits,
					newState,
					oldState,
					pathName,
					resolvedPath,
					seenLines,
					snapshotPersisted: false,
				});
				return {
					editDiff,
					newFileVersion: newState.fileVersion,
					observationId: observation.id,
					oldFileVersion: oldState.fileVersion,
					path: pathName,
					replacements,
					seenLines: [...observation.seenLines],
				};
			}
		)
	);
};

const stateFromText = (text: LosslessText): FileState => {
	const bytes = encodeLosslessText(text);
	return { bytes, fileVersion: computeFileVersion(bytes), text };
};

const sourceStateForVersion = (
	state: FileState,
	snapshot: FileSnapshot | null,
	version: FileVersion
): FileState | null => {
	if (state.fileVersion === version) {
		return state;
	}
	if (snapshot === null) {
		return null;
	}
	return {
		bytes: new Uint8Array(snapshot.bytes),
		fileVersion: snapshot.fileVersion,
		text: decodeLosslessText(snapshot.bytes),
	};
};
const resolveVerifiedHunk = async (
	section: ParsedSection,
	state: FileState,
	context: VersionedEditingContext,
	resolvedPath: string,
	maxRecoveryComparisons: number
): Promise<{
	hunk: PositionedHunk;
	observation: { seenLines: readonly LineRange[] };
	oldState: FileState;
	sourceHunk: PositionedHunk;
	sourceState: FileState;
}> => {
	const observation = await context.store.getObservation(
		context.sessionId,
		resolvedPath,
		section.version
	);
	const snapshot = await context.store.getSnapshot(
		resolvedPath,
		section.version
	);
	const sourceState = sourceStateForVersion(state, snapshot, section.version);
	if (sourceState === null) {
		throw new CodingToolError(
			"stale-edit",
			"The requested File Version is no longer available for recovery. Read the file again.",
			{ recovery: { action: "reread", path: section.path } }
		);
	}
	const parsedHunk = section.hunks[0];
	if (parsedHunk === undefined) {
		throw new CodingToolError("invalid-patch", "Verified patch has no hunk.", {
			recovery: { action: "correct-input", path: section.path },
		});
	}
	if (parsedHunk.kind === "replace" || parsedHunk.kind === "cut") {
		const endLine = parsedHunk.endLine as number;
		if (
			parsedHunk.startLine > sourceState.text.lines.length ||
			endLine > sourceState.text.lines.length
		) {
			throw new CodingToolError(
				"line-range-out-of-bounds",
				"Verified edit range is outside the observed file.",
				{ recovery: { action: "reread", path: section.path } }
			);
		}
	}
	if (
		(parsedHunk.kind === "insert-before" ||
			parsedHunk.kind === "insert-after") &&
		(parsedHunk.startLine < 1 ||
			parsedHunk.startLine > sourceState.text.lines.length)
	) {
		throw new CodingToolError(
			"line-range-out-of-bounds",
			"Verified insertion anchor is outside the observed file.",
			{ recovery: { action: "reread", path: section.path } }
		);
	}
	const authorizedObservation = ensureVisible(
		observation,
		parsedHunk,
		section.path
	);
	const sourceHunk: PositionedHunk = {
		...parsedHunk,
		endLine: parsedHunk.endLine ?? parsedHunk.startLine,
		startLine: parsedHunk.startLine,
	};
	if (parsedHunk.kind === "replace" || parsedHunk.kind === "cut") {
		const mapped =
			state.fileVersion === section.version
				? {
						endLine: sourceHunk.endLine,
						startLine: sourceHunk.startLine,
					}
				: findMappedLine(
						sourceState.text.lines,
						state.text.lines,
						sourceHunk.startLine,
						sourceHunk.endLine,
						section.path,
						maxRecoveryComparisons
					);
		return {
			hunk: {
				...parsedHunk,
				endLine: mapped.endLine,
				startLine: mapped.startLine,
			},
			observation: authorizedObservation,
			oldState: state,
			sourceHunk,
			sourceState,
		};
	}
	const mapped =
		state.fileVersion === section.version
			? parsedHunk.startLine
			: mapInsertionBoundary(
					sourceState.text.lines,
					state.text.lines,
					parsedHunk.startLine,
					section.path,
					maxRecoveryComparisons,
					parsedHunk.kind === "insert-before" ? "before" : "after"
				);
	return {
		hunk: { ...parsedHunk, endLine: mapped, startLine: mapped },
		observation: authorizedObservation,
		oldState: state,
		sourceHunk,
		sourceState,
	};
};

const countLineSequenceMatches = (
	lines: readonly LosslessTextLine[],
	target: readonly LosslessTextLine[]
): number => {
	let matches = 0;
	for (let start = 0; start + target.length <= lines.length; start += 1) {
		if (
			target.every((line, offset) =>
				sameLosslessLine(line, lines[start + offset])
			)
		) {
			matches += 1;
		}
	}
	return matches;
};
const countMatchingLines = (
	lines: readonly LosslessTextLine[],
	target: LosslessTextLine
): number => {
	let matches = 0;
	for (const line of lines) {
		if (sameLosslessLine(line, target)) {
			matches += 1;
		}
	}
	return matches;
};

const createStableLineMap = ({
	lineRange,
	liveLines,
	maxComparisons,
	pathName,
	sourceLines,
}: {
	lineRange: LineRange;
	liveLines: readonly LosslessTextLine[];
	maxComparisons: number;
	pathName: string;
	sourceLines: readonly LosslessTextLine[];
}): Map<number, number> => {
	const changes = diffArrays([...sourceLines], [...liveLines], {
		comparator: sameLosslessLine,
		maxEditLength: maxComparisons,
	});
	if (changes === undefined) {
		throw new CodingToolError(
			"recovery-out-of-budget",
			"Snapshot recovery exceeded its comparison budget. Read the file again.",
			{
				details: { lineRange, maxComparisons, path: pathName },
				recovery: { action: "reread", lineRange, path: pathName },
			}
		);
	}
	const mapping = new Map<number, number>();
	let sourceIndex = 0;
	let liveIndex = 0;
	for (const change of changes) {
		if (change.added) {
			liveIndex += change.count;
			continue;
		}
		if (change.removed) {
			sourceIndex += change.count;
			continue;
		}
		for (let offset = 0; offset < change.count; offset += 1) {
			const sourceLine = sourceLines[sourceIndex + offset];
			const liveLine = liveLines[liveIndex + offset];
			if (
				sourceLine !== undefined &&
				liveLine !== undefined &&
				countMatchingLines(sourceLines, sourceLine) === 1 &&
				countMatchingLines(liveLines, liveLine) === 1
			) {
				mapping.set(sourceIndex + offset + 1, liveIndex + offset + 1);
			}
		}
		sourceIndex += change.count;
		liveIndex += change.count;
	}
	return mapping;
};
const authoredStartLine = (hunk: PositionedHunk): number => {
	if (hunk.kind === "insert-before") {
		return hunk.startLine;
	}
	if (hunk.kind === "insert-after") {
		return hunk.startLine + 1;
	}
	return hunk.startLine;
};

const oldLineCount = (hunk: PositionedHunk): number =>
	hunk.kind === "insert-before" || hunk.kind === "insert-after"
		? 0
		: hunk.endLine - hunk.startLine + 1;

const mapObservedLine = (
	line: number,
	hunk: PositionedHunk,
	delta: number
): number | undefined => {
	if (
		(hunk.kind === "replace" || hunk.kind === "cut") &&
		line >= hunk.startLine &&
		line <= hunk.endLine
	) {
		return;
	}
	if (hunk.kind === "insert-before" && line >= hunk.startLine) {
		return line + delta;
	}
	if (hunk.kind === "insert-after" && line > hunk.startLine) {
		return line + delta;
	}
	if (hunk.kind !== "insert-before" && hunk.kind !== "insert-after") {
		return line > hunk.endLine ? line + delta : line;
	}
	return line;
};
const isSourceReplacementLine = (line: number, hunk: PositionedHunk): boolean =>
	(hunk.kind === "replace" || hunk.kind === "cut") &&
	line >= hunk.startLine &&
	line <= hunk.endLine;

const assertSeenLineRecoveryBudget = ({
	lineRange,
	liveLineCount,
	maxRecoveryComparisons,
	observed,
	pathName,
	sameVersion,
}: {
	lineRange: LineRange;
	liveLineCount: number;
	maxRecoveryComparisons: number;
	observed: readonly LineRange[];
	pathName: string;
	sameVersion: boolean;
}): void => {
	const observedLineCount = observed.reduce(
		(total, range) =>
			total + (range.endLine ?? range.startLine) - range.startLine + 1,
		0
	);
	if (
		!sameVersion &&
		observedLineCount * liveLineCount > maxRecoveryComparisons
	) {
		throw new CodingToolError(
			"recovery-out-of-budget",
			"Seen Lines recovery exceeded its comparison budget. Read the file again.",
			{
				details: {
					lineRange,
					maxComparisons: maxRecoveryComparisons,
					path: pathName,
				},
				recovery: {
					action: "reread",
					lineRange,
					path: pathName,
				},
			}
		);
	}
};
const mapSeenLinesAfterHunk = ({
	bodyLength,
	liveHunk,
	liveLines,
	maxRecoveryComparisons,
	newLineCount,
	observed,
	pathName,
	sourceHunk,
	sourceLines,
	sameVersion,
}: {
	bodyLength: number;
	liveHunk: PositionedHunk;
	liveLines: readonly LosslessTextLine[];
	maxRecoveryComparisons: number;
	newLineCount: number;
	observed: readonly LineRange[];
	pathName: string;
	sourceHunk: PositionedHunk;
	sourceLines: readonly LosslessTextLine[];
	sameVersion: boolean;
}): LineRange[] => {
	assertSeenLineRecoveryBudget({
		lineRange: lineRangeForHunk(sourceHunk),
		liveLineCount: liveLines.length,
		maxRecoveryComparisons,
		observed,
		pathName,
		sameVersion,
	});
	const seen = new Set<number>();
	const authoredStart = authoredStartLine(liveHunk);
	for (
		let line = authoredStart;
		line < authoredStart + bodyLength && line <= newLineCount;
		line += 1
	) {
		seen.add(line);
	}
	const liveLineMap = sameVersion
		? undefined
		: createStableLineMap({
				lineRange: lineRangeForHunk(sourceHunk),
				liveLines,
				maxComparisons: maxRecoveryComparisons,
				pathName,
				sourceLines,
			});
	const delta = bodyLength - oldLineCount(liveHunk);
	for (const range of observed) {
		const endLine = range.endLine ?? range.startLine;
		for (let line = range.startLine; line <= endLine; line += 1) {
			if (isSourceReplacementLine(line, sourceHunk)) {
				continue;
			}
			const liveLine = sameVersion ? line : liveLineMap?.get(line);
			if (liveLine === undefined) {
				continue;
			}
			const mappedLine = mapObservedLine(liveLine, liveHunk, delta);
			if (
				mappedLine !== undefined &&
				mappedLine > 0 &&
				mappedLine <= newLineCount
			) {
				seen.add(mappedLine);
			}
		}
	}
	return lineRangeForLines([...seen].sort((left, right) => left - right));
};

const runHashlineEdit = async (
	input: Extract<EditInput, { patch: string }>,
	options: EditOptions,
	context: VersionedEditingContext,
	limits: ToolResourceLimits
): Promise<EditOutput> => {
	const section = parseVerifiedPatch(input.patch);
	if (section.hunks.length !== 1) {
		throw new CodingToolError(
			"invalid-patch",
			"Hashline mode accepts exactly one verified line operation.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const resolvedPath = await resolveExistingTextPath(
		section.path,
		options.allowExternalPath === true
	);
	const state = await readVersionedFile(resolvedPath);
	const resolved = await resolveVerifiedHunk(
		section,
		state,
		context,
		resolvedPath,
		limits.edit.maxRecoveryComparisons
	);
	const nextText = applyLineHunk(resolved.oldState.text, resolved.hunk);
	const nextState = stateFromText(nextText);
	if (nextState.fileVersion === state.fileVersion) {
		throw new CodingToolError(
			"no-op-edit",
			`Edit produced no content changes: ${section.path}.`,
			{ recovery: { action: "correct-input", path: section.path } }
		);
	}
	const seenLines = mapSeenLinesAfterHunk({
		bodyLength: section.hunks[0]?.body.length ?? 0,
		liveHunk: resolved.hunk,
		liveLines: resolved.oldState.text.lines,
		maxRecoveryComparisons: limits.edit.maxRecoveryComparisons,
		newLineCount: nextText.lines.length,
		observed: resolved.observation.seenLines,
		pathName: section.path,
		sameVersion: state.fileVersion === section.version,
		sourceLines: resolved.sourceState.text.lines,
		sourceHunk: resolved.sourceHunk,
	});
	return commitMutation({
		context,
		limits,
		newState: nextState,
		oldState: state,
		pathName: section.path,
		resolvedPath,
		seenLines,
	});
};

const normalizedText = (value: string): string =>
	value.normalize("NFKC").replace(/\s+/gu, " ").trim();
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
			...(hint === undefined ? {} : { hint }),
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

type ResolvedSloppyHunk = Readonly<{
	hunk: SloppyHunk;
	startIndex: number;
}>;

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

const runSloppyEdit = async (
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
	const resolvedPath = await resolveExistingTextPath(
		patch.path,
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

const runReplaceEdit = async (
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
	const resolvedPath = await resolveExistingTextPath(
		input.path,
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

export const runEditTool = async (
	input: EditInput,
	options: EditOptions = {}
): Promise<EditOutput> => {
	const context = options.versionedEditing ?? defaultVersionedEditingContext;
	const limits = options.resourceLimits ?? getToolResourceLimits();
	if ("patch" in input && byteLength(input.patch) > limits.edit.maxPatchBytes) {
		throw new CodingToolError(
			"edit-input-out-of-budget",
			"Edit patch input exceeds the configured input budget.",
			{
				details: {
					actualBytes: byteLength(input.patch),
					maxBytes: limits.edit.maxPatchBytes,
				},
				recovery: {
					action: "correct-input",
					message: "Reduce the patch input or use a larger resource limit.",
				},
			}
		);
	}
	const ensureActiveMode = (requestedMode: string): void => {
		if (requestedMode === context.editMode) {
			return;
		}
		throw new CodingToolError(
			"edit-mode-mismatch",
			`Edit Mode '${requestedMode}' is not active; the current mode is '${context.editMode}'.`,
			{
				details: { actualMode: context.editMode, requestedMode },
				recovery: { action: "correct-input" },
			}
		);
	};
	if ("mode" in input && input.mode === "replace") {
		ensureActiveMode("replace");
		return runReplaceEdit(input, options, context, limits);
	}
	if ("mode" in input && input.mode === "sloppy") {
		ensureActiveMode("sloppy");
		return runSloppyEdit(input, options, context, limits);
	}
	ensureActiveMode("hashline");
	return runHashlineEdit(input, options, context, limits);
};

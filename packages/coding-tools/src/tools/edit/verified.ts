import { randomUUID } from "node:crypto";
import { diffArrays } from "diff";
import {
	CodingToolError,
	type FileSnapshot,
	isCodingToolError,
	type VersionedEditingContext,
} from "../../versioned/contracts";
import {
	assertObservedLineBudget,
	atomicReplaceFile,
	expectFileVersion,
	type FileState,
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
import type {
	ResourceLimitOptions,
	ToolResourceLimits,
} from "../resource-limits";
import { buildEditDiff, buildFullEditDiff } from "./diff";
import type { EditInput, EditOutput } from "./schema";
export type EditOptions = ResourceLimitOptions & {
	allowSloppy?: boolean;
	approvedExternalPaths?: readonly string[];
	approvedWorkspacePaths?: readonly string[];
	versionedEditing?: VersionedEditingContext;
};
export const resolveAuthorizedTextPath = async (
	inputPath: string,
	options: Pick<
		EditOptions,
		"approvedExternalPaths" | "approvedWorkspacePaths"
	>,
	allowExternalPath: boolean
): Promise<string> => {
	const resolvedPath = await resolveExistingTextPath(
		inputPath,
		allowExternalPath
	);
	const approvedPaths = new Set([
		...(options.approvedExternalPaths ?? []),
		...(options.approvedWorkspacePaths ?? []),
	]);
	if (approvedPaths.size > 0 && !approvedPaths.has(resolvedPath)) {
		throw new CodingToolError(
			"approved-path-changed",
			"An approved path changed before execution.",
			{ recovery: { action: "reread", path: inputPath } }
		);
	}
	return resolvedPath;
};
export type ParsedSection = Readonly<{
	hunks: readonly ParsedHunk[];
	path: string;
	version: FileVersion;
}>;

export type ParsedHunk = Readonly<{
	body: readonly string[];
	endLine?: number;
	kind: "cut" | "insert-after" | "insert-before" | "replace";
	startLine: number;
}>;

export type RecoveryBudget = {
	remaining: number;
};
export type PositionedHunk = ParsedHunk &
	Readonly<{
		endLine: number;
		startLine: number;
	}>;

const PATCH_HEADER_PATTERN = /^\[(.*)\]$/u;
const VERSION_SUFFIX_LENGTH = 33;
const OPERATION_PATTERN =
	/^(?:PUT (?:([1-9]\d*)\.=(\d+)|<([1-9]\d*)|>([1-9]\d*)):|CUT ([1-9]\d*)\.=(\d+))$/u;
const FILE_VERSION_PATTERN = /^[0-9a-f]{32}$/u;
const LINE_NUMBER_PATTERN = /^[1-9]\d*$/u;

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
export const parseVerifiedPatch = (patch: string): ParsedSection => {
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

export const applyLineHunk = (
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
		await atomicReplaceFile(resolvedPath, oldState.bytes, newState.fileVersion);
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

export const commitMutation = async ({
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
	const fullDiff = buildFullEditDiff(
		textForDiff(oldState),
		textForDiff(newState),
		pathName,
		limits.edit
	);
	if (fullDiff.truncated) {
		throw new CodingToolError(
			"edit-diff-artifact-out-of-budget",
			"The complete edit diff exceeds the configured audit artifact budget.",
			{ recovery: { action: "correct-input" } }
		);
	}
	const preflightBytes =
		oldState.bytes.byteLength +
		newState.bytes.byteLength +
		byteLength(fullDiff.patch);
	if (preflightBytes > limits.edit.maxPreflightBytes) {
		throw new CodingToolError(
			"edit-preflight-out-of-budget",
			"The complete edit transaction exceeds its preflight byte budget.",
			{
				details: {
					actualBytes: preflightBytes,
					maxBytes: limits.edit.maxPreflightBytes,
				},
				recovery: { action: "correct-input" },
			}
		);
	}
	const fullDiffArtifact =
		editDiff.truncated === false
			? undefined
			: {
					byteLength: new TextEncoder().encode(fullDiff.patch).byteLength,
					content: fullDiff.patch,
					createdAt: Date.now(),
					id: randomUUID(),
					sessionId: context.sessionId,
				};
	assertObservedLineBudget(
		seenLines,
		limits.read.maxObservedLines,
		resolvedPath
	);
	const mutate = (assertLease: () => void) =>
		withFileMutationLock(resolvedPath, () =>
			withSnapshotFailureCleanup(
				context,
				{ fileVersion: newState.fileVersion, path: resolvedPath },
				async () => {
					assertLease();
					const latest = await readVersionedFile(resolvedPath);
					expectFileVersion(latest.fileVersion, oldState.fileVersion, pathName);
					const latestBeforeRename = await readVersionedFile(resolvedPath);
					expectFileVersion(
						latestBeforeRename.fileVersion,
						oldState.fileVersion,
						pathName
					);
					if (fullDiffArtifact !== undefined) {
						if (context.store.saveFullDiffArtifact === undefined) {
							throw new CodingToolError(
								"edit-diff-artifact-unavailable",
								"A complete diff is required but the active session store cannot persist it.",
								{ recovery: { action: "correct-input" } }
							);
						}
						await context.store.saveFullDiffArtifact(fullDiffArtifact);
					}
					assertLease();
					await atomicReplaceFile(
						resolvedPath,
						newState.bytes,
						oldState.fileVersion
					);
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
					assertLease();
					return {
						editDiff: editDiff.truncated ? undefined : editDiff,
						fullDiffArtifact:
							fullDiffArtifact === undefined
								? undefined
								: {
										byteLength: fullDiffArtifact.byteLength,
										id: fullDiffArtifact.id,
									},
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
	return context.store.withPathLeases === undefined
		? mutate(() => undefined)
		: context.store.withPathLeases([resolvedPath], mutate);
};

export const stateFromText = (text: LosslessText): FileState => {
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
const reserveRecoveryComparisons = ({
	budget,
	lineRange,
	liveLineCount,
	maxComparisons,
	pathName,
	snapshotLineCount,
	targetLength,
}: {
	budget?: RecoveryBudget;
	lineRange: LineRange;
	liveLineCount: number;
	maxComparisons: number;
	pathName: string;
	snapshotLineCount: number;
	targetLength: number;
}): number => {
	const estimated = Math.max(
		1,
		targetLength * (liveLineCount + snapshotLineCount)
	);
	const available = Math.min(
		maxComparisons,
		budget?.remaining ?? maxComparisons
	);
	if (estimated > available) {
		throw new CodingToolError(
			"recovery-out-of-budget",
			"Snapshot recovery exceeded its comparison budget. Read the file again.",
			{
				details: {
					lineRange,
					maxComparisons,
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
	if (budget !== undefined) {
		budget.remaining -= estimated;
	}
	return available;
};
export const resolveVerifiedHunk = async (
	section: ParsedSection,
	state: FileState,
	context: VersionedEditingContext,
	resolvedPath: string,
	maxRecoveryComparisons: number,
	requestedHunk?: ParsedHunk,
	recoveryBudget?: RecoveryBudget
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
	const parsedHunk = requestedHunk ?? section.hunks[0];
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
						reserveRecoveryComparisons({
							budget: recoveryBudget,
							lineRange: {
								endLine: sourceHunk.endLine,
								startLine: sourceHunk.startLine,
							},
							liveLineCount: state.text.lines.length,
							maxComparisons: maxRecoveryComparisons,
							pathName: section.path,
							snapshotLineCount: sourceState.text.lines.length,
							targetLength: sourceHunk.endLine - sourceHunk.startLine + 1,
						})
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
					reserveRecoveryComparisons({
						budget: recoveryBudget,
						lineRange: { startLine: parsedHunk.startLine },
						liveLineCount: state.text.lines.length,
						maxComparisons: maxRecoveryComparisons,
						pathName: section.path,
						snapshotLineCount: sourceState.text.lines.length,
						targetLength: 1,
					}),
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

export const createStableLineMap = ({
	budget,
	lineRange,
	liveLines,
	maxComparisons,
	pathName,
	sourceLines,
}: {
	budget?: RecoveryBudget;
	lineRange: LineRange;
	liveLines: readonly LosslessTextLine[];
	maxComparisons: number;
	pathName: string;
	sourceLines: readonly LosslessTextLine[];
}): Map<number, number> => {
	const estimatedComparisons = Math.max(
		1,
		sourceLines.length * (sourceLines.length + liveLines.length)
	);
	const availableComparisons = Math.min(
		maxComparisons,
		budget?.remaining ?? maxComparisons
	);
	if (budget !== undefined && estimatedComparisons > availableComparisons) {
		throw new CodingToolError(
			"recovery-out-of-budget",
			"Snapshot recovery exceeded its comparison budget. Read the file again.",
			{
				details: {
					lineRange,
					maxComparisons,
					path: pathName,
				},
				recovery: { action: "reread", lineRange, path: pathName },
			}
		);
	}
	if (budget !== undefined) {
		budget.remaining -= estimatedComparisons;
	}
	const changes = diffArrays([...sourceLines], [...liveLines], {
		comparator: sameLosslessLine,
		maxEditLength: availableComparisons,
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

export const runHashlineEdit = async (
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
	const resolvedPath = await resolveAuthorizedTextPath(
		section.path,
		options,
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

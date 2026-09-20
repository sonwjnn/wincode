import { randomUUID } from "node:crypto";
import {
	CodingToolError,
	type FileObservation,
	type VersionedEditingContext,
} from "../../versioned/contracts";
import type { FileState } from "../../versioned/filesystem";
import {
	assertObservedLineBudget,
	atomicReplaceFile,
	expectFileVersion,
	persistFileObservation,
	readVersionedFile,
	resolveExistingTextPath,
	snapshotForState,
	withFileMutationLock,
} from "../../versioned/filesystem";
import {
	byteLength,
	type FileVersion,
	type LineRange,
	type LosslessText,
	lineRangeForLines,
} from "../../versioned/model";
import type { ToolResourceLimits } from "../resource-limits";
import { buildEditDiff, buildFullEditDiff } from "./diff";
import type { EditDiff, EditInput, EditOutput } from "./schema";
import {
	applyLineHunk,
	createStableLineMap,
	type EditOptions,
	type ParsedSection,
	type PositionedHunk,
	parseVerifiedPatch,
	type RecoveryBudget,
	resolveVerifiedHunk,
	stateFromText,
} from "./verified";

type MultiEditInput = Extract<EditInput, { mode: "patch" | "apply_patch" }>;

type DeclaredHunk = Readonly<{
	declarationOrder: number;
	section: ParsedSection;
	sourceHunk: PositionedHunk;
	liveHunk: PositionedHunk;
}>;

type PlannedFile = Readonly<{
	canonicalPath: string;
	displayPath: string;
	newState: FileState;
	oldObservation: FileObservation | null;
	oldState: FileState;
	thunks: readonly DeclaredHunk[];
	seenLines: readonly LineRange[];
	editDiff: EditDiff;
	fullDiff: EditDiff;
}>;

const VERIFIED_HEADER_PATTERN = /^\[.*\]$/u;
const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";

const patchLines = (patch: string): string[] => {
	const lines = patch.replace(/\r\n?/gu, "\n").split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
};

const splitSections = (patch: string): ParsedSection[] => {
	const lines = patchLines(patch);
	if (lines[0] === PATCH_BEGIN) {
		if (lines.at(-1) !== PATCH_END) {
			throw new CodingToolError(
				"invalid-patch",
				"A multi-file patch must close its Begin Patch envelope.",
				{ recovery: { action: "correct-input" } }
			);
		}
		lines.shift();
		lines.pop();
	}
	if (lines.length === 0) {
		throw new CodingToolError("invalid-patch", "Patch input is empty.", {
			recovery: { action: "correct-input" },
		});
	}
	const starts = lines.flatMap((line, index) =>
		VERIFIED_HEADER_PATTERN.test(line) ? [index] : []
	);
	if (starts.length === 0 || starts[0] !== 0) {
		throw new CodingToolError(
			"invalid-patch",
			"A multi-file patch must begin with a verified section header.",
			{ recovery: { action: "correct-input" } }
		);
	}
	return starts.map((start, index) => {
		const end = starts[index + 1] ?? lines.length;
		const section = lines.slice(start, end);
		return parseVerifiedPatch(section.join("\n"));
	});
};
export const validateMultiEditPatch = (
	patch: string,
	mode: "patch" | "apply_patch"
): void => {
	const sections = splitSections(patch);
	if (mode === "patch" && sections.length !== 1) {
		throw new CodingToolError(
			"invalid-patch",
			"Patch mode accepts exactly one verified file section.",
			{ recovery: { action: "correct-input" } }
		);
	}
};

const hunkLineCount = (hunk: PositionedHunk): number =>
	hunk.kind === "insert-before" || hunk.kind === "insert-after"
		? 0
		: hunk.endLine - hunk.startLine + 1;

const boundaryPosition = (hunk: PositionedHunk): number | undefined => {
	if (hunk.kind === "insert-before") {
		return hunk.startLine;
	}
	if (hunk.kind === "insert-after") {
		return hunk.startLine + 1;
	}
	return;
};

const changedRange = (
	hunk: PositionedHunk
): readonly [number, number] | null =>
	hunk.kind === "insert-before" || hunk.kind === "insert-after"
		? null
		: [hunk.startLine, hunk.endLine];

const assertSourceHunksDoNotOverlap = (
	hunks: readonly DeclaredHunk[],
	pathName: string
): void => {
	for (let leftIndex = 0; leftIndex < hunks.length; leftIndex += 1) {
		const left = hunks[leftIndex] as DeclaredHunk;
		const leftRange = changedRange(left.sourceHunk);
		const leftBoundary = boundaryPosition(left.sourceHunk);
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < hunks.length;
			rightIndex += 1
		) {
			const right = hunks[rightIndex] as DeclaredHunk;
			const rightRange = changedRange(right.sourceHunk);
			const rightBoundary = boundaryPosition(right.sourceHunk);
			if (
				leftRange &&
				rightRange &&
				leftRange[0] <= rightRange[1] &&
				rightRange[0] <= leftRange[1]
			) {
				throw new CodingToolError(
					"hunk-overlap",
					`Verified edit hunks overlap in ${pathName}.`,
					{ recovery: { action: "reread", path: pathName } }
				);
			}
			if (
				leftBoundary !== undefined &&
				rightRange &&
				leftBoundary >= rightRange[0] &&
				leftBoundary <= rightRange[1]
			) {
				throw new CodingToolError(
					"hunk-overlap",
					`An insertion boundary intersects a changed range in ${pathName}.`,
					{ recovery: { action: "reread", path: pathName } }
				);
			}
			if (
				rightBoundary !== undefined &&
				leftRange &&
				rightBoundary >= leftRange[0] &&
				rightBoundary <= leftRange[1]
			) {
				throw new CodingToolError(
					"hunk-overlap",
					`An insertion boundary intersects a changed range in ${pathName}.`,
					{ recovery: { action: "reread", path: pathName } }
				);
			}
		}
	}
};

const declarationOrderForInsertion = (
	left: DeclaredHunk,
	right: DeclaredHunk
): number => {
	const leftBoundary = boundaryPosition(left.liveHunk);
	const rightBoundary = boundaryPosition(right.liveHunk);
	if (leftBoundary === rightBoundary) {
		return right.declarationOrder - left.declarationOrder;
	}
	return (
		(rightBoundary ?? right.liveHunk.startLine) -
		(leftBoundary ?? left.liveHunk.startLine)
	);
};

const applyOrderedHunks = (
	text: LosslessText,
	ordered: readonly DeclaredHunk[],
	pathName: string
): LosslessText => {
	let nextText = text;
	for (const declared of ordered) {
		const candidate = applyLineHunk(nextText, declared.liveHunk);
		if (
			stateFromText(candidate).fileVersion ===
			stateFromText(nextText).fileVersion
		) {
			throw new CodingToolError(
				"no-op-edit",
				`Verified edit hunk produced no changes in ${pathName}.`,
				{ recovery: { action: "correct-input", path: pathName } }
			);
		}
		nextText = candidate;
	}
	return nextText;
};

const mapAuthoredLine = (
	declared: DeclaredHunk,
	index: number,
	hunks: readonly DeclaredHunk[]
): number => {
	let line =
		(declared.liveHunk.kind === "insert-after"
			? declared.liveHunk.startLine + 1
			: declared.liveHunk.startLine) + index;
	for (const other of hunks) {
		if (other === declared) {
			continue;
		}
		const otherRange = changedRange(other.liveHunk);
		if (otherRange && line > otherRange[1]) {
			line += other.liveHunk.body.length - hunkLineCount(other.liveHunk);
			continue;
		}
		const otherBoundary = boundaryPosition(other.liveHunk);
		if (
			otherBoundary !== undefined &&
			(line > otherBoundary ||
				(line === otherBoundary &&
					other.declarationOrder < declared.declarationOrder))
		) {
			line += other.liveHunk.body.length;
		}
	}
	return line;
};

const applyHunks = (
	state: FileState,
	hunks: readonly DeclaredHunk[],
	pathName: string
): { newState: FileState; seenLines: readonly LineRange[] } => {
	const ordered = [...hunks].sort((left, right) => {
		const rightPosition =
			boundaryPosition(right.liveHunk) ?? right.liveHunk.startLine;
		const leftPosition =
			boundaryPosition(left.liveHunk) ?? left.liveHunk.startLine;
		return rightPosition === leftPosition
			? declarationOrderForInsertion(left, right)
			: rightPosition - leftPosition;
	});
	const authoredLines = new Set<number>();
	for (const declared of hunks) {
		for (let index = 0; index < declared.liveHunk.body.length; index += 1) {
			authoredLines.add(mapAuthoredLine(declared, index, hunks));
		}
	}
	return {
		newState: stateFromText(applyOrderedHunks(state.text, ordered, pathName)),
		seenLines: lineRangeForLines([...authoredLines].sort((a, b) => a - b)),
	};
};

const mapObservedLine = ({
	liveLine,
	sourceLine,
	thunks,
}: {
	liveLine: number;
	sourceLine: number;
	thunks: readonly DeclaredHunk[];
}): number | undefined => {
	let mapped = liveLine;
	for (const declared of thunks) {
		const sourceRange = changedRange(declared.sourceHunk);
		if (
			sourceRange &&
			sourceLine >= sourceRange[0] &&
			sourceLine <= sourceRange[1]
		) {
			return;
		}
		const liveHunk = declared.liveHunk;
		const liveRange = changedRange(liveHunk);
		if (liveRange && liveLine > liveRange[1]) {
			mapped += liveHunk.body.length - hunkLineCount(liveHunk);
		}
		if (liveHunk.kind === "insert-before" && liveLine >= liveHunk.startLine) {
			mapped += liveHunk.body.length;
		}
		if (liveHunk.kind === "insert-after" && liveLine > liveHunk.startLine) {
			mapped += liveHunk.body.length;
		}
	}
	return mapped;
};
const mapObservedLines = ({
	liveState,
	maxRecoveryComparisons,
	observation,
	pathName,
	preserve,
	recoveryBudget,
	sourceState,
	thunks,
}: {
	liveState: FileState;
	maxRecoveryComparisons: number;
	observation: FileObservation | null;
	pathName: string;
	preserve: boolean;
	recoveryBudget: RecoveryBudget;
	sourceState: FileState;
	thunks: readonly DeclaredHunk[];
}): LineRange[] => {
	if (observation === null) {
		return [];
	}
	const sourceToLive = preserve
		? undefined
		: createStableLineMap({
				budget: recoveryBudget,
				lineRange: {
					endLine: Math.max(1, sourceState.text.lines.length),
					startLine: 1,
				},
				liveLines: liveState.text.lines,
				maxComparisons: maxRecoveryComparisons,
				pathName,
				sourceLines: sourceState.text.lines,
			});
	const lines: number[] = [];
	for (const range of observation.seenLines) {
		const endLine = range.endLine ?? range.startLine;
		for (
			let sourceLine = range.startLine;
			sourceLine <= endLine;
			sourceLine += 1
		) {
			const liveLine = preserve ? sourceLine : sourceToLive?.get(sourceLine);
			if (liveLine === undefined) {
				continue;
			}
			const mapped = mapObservedLine({ liveLine, sourceLine, thunks });
			if (mapped !== undefined) {
				lines.push(mapped);
			}
		}
	}
	return lineRangeForLines([...new Set(lines)].sort((a, b) => a - b));
};

const diffForStates = (
	oldState: FileState,
	newState: FileState,
	pathName: string,
	limits: ToolResourceLimits
): PlannedFile["editDiff"] =>
	buildEditDiff(
		new TextDecoder().decode(oldState.bytes),
		new TextDecoder().decode(newState.bytes),
		pathName,
		limits.edit
	);

const fullDiffForStates = (
	oldState: FileState,
	newState: FileState,
	pathName: string,
	limits: ToolResourceLimits
): PlannedFile["fullDiff"] =>
	buildFullEditDiff(
		new TextDecoder().decode(oldState.bytes),
		new TextDecoder().decode(newState.bytes),
		pathName,
		limits.edit
	);

const withLeases = async <T>(
	context: VersionedEditingContext,
	paths: readonly string[],
	operation: (assertLease: () => void) => Promise<T>
): Promise<T> =>
	context.store.withPathLeases === undefined
		? operation(() => undefined)
		: context.store.withPathLeases(paths, operation);
const assertCanonicalPaths = async (
	declaredPaths: readonly string[],
	canonicalByDeclared: ReadonlyMap<string, string>,
	allowExternalPath: boolean
): Promise<void> => {
	for (const declaredPath of declaredPaths) {
		const expectedPath = canonicalByDeclared.get(declaredPath);
		const currentPath = await resolveExistingTextPath(
			declaredPath,
			allowExternalPath
		);
		if (expectedPath !== currentPath) {
			throw new CodingToolError(
				"approved-path-changed",
				"An approved path changed before execution.",
				{ recovery: { action: "reread", path: declaredPath } }
			);
		}
	}
};

const cleanupNewObservations = async (
	context: VersionedEditingContext,
	plans: readonly PlannedFile[]
): Promise<void> => {
	if (context.store.discardObservation === undefined) {
		return;
	}
	for (const plan of plans) {
		await context.store
			.discardObservation(
				context.sessionId,
				plan.canonicalPath,
				plan.newState.fileVersion
			)
			.catch(() => undefined);
	}
};

const rollbackCommitted = async (
	committed: readonly PlannedFile[],
	failure: unknown
): Promise<void> => {
	let rollbackError: unknown;
	for (const plan of [...committed].reverse()) {
		try {
			const current = await readVersionedFile(plan.canonicalPath);
			expectFileVersion(
				current.fileVersion,
				plan.newState.fileVersion,
				plan.displayPath
			);
			await atomicReplaceFile(
				plan.canonicalPath,
				plan.oldState.bytes,
				plan.newState.fileVersion
			);
		} catch (error) {
			rollbackError = error;
			break;
		}
	}
	if (rollbackError !== undefined) {
		throw new CodingToolError(
			"transaction-rollback-failed",
			"The edit transaction could not prove that every changed file was restored.",
			{
				details: {
					cause: failure instanceof Error ? failure.message : String(failure),
					rollback:
						rollbackError instanceof Error
							? rollbackError.message
							: String(rollbackError),
				},
				recovery: { action: "reread" },
			}
		);
	}
};

const executePlans = async (
	context: VersionedEditingContext,
	limits: ToolResourceLimits,
	plans: readonly PlannedFile[],
	assertLease: () => void
): Promise<EditOutput> => {
	const artifacts = plans.flatMap((plan) => {
		if (!plan.editDiff.truncated) {
			return [];
		}
		if (plan.fullDiff.truncated) {
			throw new CodingToolError(
				"edit-diff-artifact-out-of-budget",
				"The complete edit diff exceeds the configured audit artifact budget.",
				{ recovery: { action: "correct-input" } }
			);
		}
		return [
			{
				artifact: {
					byteLength: byteLength(plan.fullDiff.patch),
					content: plan.fullDiff.patch,
					createdAt: Date.now(),
					id: randomUUID(),
					sessionId: context.sessionId,
				},
				plan,
			},
		];
	});
	if (
		artifacts.length > 0 &&
		context.store.saveFullDiffArtifact === undefined
	) {
		throw new CodingToolError(
			"edit-diff-artifact-unavailable",
			"A complete diff is required but the active session store cannot persist it.",
			{ recovery: { action: "correct-input" } }
		);
	}
	for (const plan of plans) {
		assertObservedLineBudget(
			plan.seenLines,
			limits.read.maxObservedLines,
			plan.canonicalPath
		);
	}
	const preflightBytes = plans.reduce(
		(total, plan) =>
			total +
			plan.oldState.bytes.byteLength +
			plan.newState.bytes.byteLength +
			byteLength(plan.fullDiff.patch),
		0
	);
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
	for (const { artifact } of artifacts) {
		await context.store.saveFullDiffArtifact?.(artifact);
	}
	for (const plan of plans) {
		if (plan.oldState.bytes.byteLength <= limits.read.maxSnapshotBytes) {
			await context.store.saveSnapshot(
				snapshotForState(plan.canonicalPath, plan.oldState)
			);
		}
	}
	const committed: PlannedFile[] = [];
	try {
		assertLease();
		for (const plan of plans) {
			const live = await readVersionedFile(plan.canonicalPath);
			expectFileVersion(
				live.fileVersion,
				plan.oldState.fileVersion,
				plan.displayPath
			);
			assertLease();
			await atomicReplaceFile(
				plan.canonicalPath,
				plan.newState.bytes,
				plan.oldState.fileVersion
			);
			committed.push(plan);
		}
		for (const plan of plans) {
			assertLease();
			await persistFileObservation({
				context,
				limits,
				path: plan.canonicalPath,
				seenLines: plan.seenLines,
				state: plan.newState,
			});
			assertLease();
		}
	} catch (error) {
		await cleanupNewObservations(context, committed);
		await rollbackCommitted(committed, error);
		if (error instanceof CodingToolError) {
			throw error;
		}
		throw new CodingToolError(
			"edit-transaction-failed",
			"The edit transaction failed and was rolled back.",
			{
				details: {
					cause: error instanceof Error ? error.message : String(error),
				},
				recovery: { action: "reread" },
			}
		);
	}
	return {
		files: plans.map((plan) => {
			const artifact = artifacts.find((entry) => entry.plan === plan)?.artifact;
			return {
				editDiff: plan.editDiff.truncated ? undefined : plan.editDiff,
				fullDiffArtifact:
					artifact === undefined
						? undefined
						: { byteLength: artifact.byteLength, id: artifact.id },
				hunkCount: plan.thunks.length,
				newFileVersion: plan.newState.fileVersion,
				oldFileVersion: plan.oldState.fileVersion,
				path: plan.displayPath,
				status: "committed" as const,
			};
		}),
	};
};

const planFiles = async (
	input: MultiEditInput,
	context: VersionedEditingContext,
	limits: ToolResourceLimits,
	canonicalPaths: ReadonlyMap<string, string>
): Promise<PlannedFile[]> => {
	const sections = splitSections(input.patch);
	const groups = new Map<
		string,
		{
			canonicalPath: string;
			displayPath: string;
			sections: ParsedSection[];
		}
	>();
	for (const section of sections) {
		const canonicalPath = canonicalPaths.get(section.path);
		if (canonicalPath === undefined) {
			throw new CodingToolError(
				"invalid-patch",
				`The prepared path '${section.path}' is unavailable.`,
				{ recovery: { action: "correct-input", path: section.path } }
			);
		}
		const group = groups.get(canonicalPath);
		if (group === undefined) {
			groups.set(canonicalPath, {
				canonicalPath,
				displayPath: section.path,
				sections: [section],
			});
			continue;
		}
		if (group.sections[0]?.version !== section.version) {
			throw new CodingToolError(
				"version-conflict",
				`Repeated sections for '${section.path}' name different File Versions.`,
				{ recovery: { action: "reread", path: section.path } }
			);
		}
		group.sections.push(section);
	}
	const plans: PlannedFile[] = [];
	const recoveryBudget: RecoveryBudget = {
		remaining: limits.edit.maxRecoveryComparisons,
	};
	let declarationOrder = 0;
	let preflightBytes = 0;
	for (const group of groups.values()) {
		const oldState = await readVersionedFile(group.canonicalPath);
		const version = group.sections[0]?.version as FileVersion;
		const oldObservation = await context.store.getObservation(
			context.sessionId,
			group.canonicalPath,
			version
		);
		const thunks: DeclaredHunk[] = [];
		let sourceState: FileState | undefined;
		for (const section of group.sections) {
			for (const parsedHunk of section.hunks) {
				const resolved = await resolveVerifiedHunk(
					section,
					oldState,
					context,
					group.canonicalPath,
					limits.edit.maxRecoveryComparisons,
					parsedHunk,
					recoveryBudget
				);
				sourceState ??= resolved.sourceState;
				thunks.push({
					declarationOrder,
					section,
					sourceHunk: resolved.sourceHunk,
					liveHunk: resolved.hunk,
				});
				declarationOrder += 1;
			}
		}
		assertSourceHunksDoNotOverlap(thunks, group.displayPath);
		const applied = applyHunks(oldState, thunks, group.displayPath);
		if (applied.newState.fileVersion === oldState.fileVersion) {
			throw new CodingToolError(
				"no-op-edit",
				`Verified edit produced no changes in ${group.displayPath}.`,
				{ recovery: { action: "correct-input", path: group.displayPath } }
			);
		}
		const editDiff = diffForStates(
			oldState,
			applied.newState,
			group.displayPath,
			limits
		);
		const fullDiff = fullDiffForStates(
			oldState,
			applied.newState,
			group.displayPath,
			limits
		);
		if (fullDiff.truncated) {
			throw new CodingToolError(
				"edit-diff-artifact-out-of-budget",
				"The complete edit diff exceeds the configured audit artifact budget.",
				{ recovery: { action: "correct-input" } }
			);
		}
		preflightBytes +=
			oldState.bytes.byteLength +
			applied.newState.bytes.byteLength +
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
		plans.push({
			canonicalPath: group.canonicalPath,
			displayPath: group.displayPath,
			editDiff,
			fullDiff,
			newState: applied.newState,
			oldObservation,
			oldState,
			seenLines: [
				...mapObservedLines({
					liveState: oldState,
					maxRecoveryComparisons: limits.edit.maxRecoveryComparisons,
					observation: oldObservation,
					pathName: group.displayPath,
					preserve: oldState.fileVersion === version,
					recoveryBudget,
					sourceState: sourceState ?? oldState,
					thunks,
				}),
				...applied.seenLines,
			],
			thunks,
		});
	}
	return plans;
};
const withMutationLocks = async <T>(
	paths: readonly string[],
	operation: () => Promise<T>
): Promise<T> => {
	const ordered = [...new Set(paths)].sort();
	const acquire = async (index: number): Promise<T> =>
		index === ordered.length
			? operation()
			: withFileMutationLock(ordered[index] as string, () =>
					acquire(index + 1)
				);
	return acquire(0);
};

export const runMultiEdit = async (
	input: MultiEditInput,
	options: EditOptions,
	context: VersionedEditingContext,
	limits: ToolResourceLimits
): Promise<EditOutput> => {
	validateMultiEditPatch(input.patch, input.mode);
	const declaredPaths = splitSections(input.patch).map(
		(section) => section.path
	);
	const canonicalByDeclared = new Map<string, string>();
	const canonicalPaths: string[] = [];
	const approvedPaths = new Set([
		...(options.approvedExternalPaths ?? []),
		...(options.approvedWorkspacePaths ?? []),
	]);
	for (const declaredPath of declaredPaths) {
		const canonicalPath = await resolveExistingTextPath(
			declaredPath,
			options.allowExternalPath === true
		);
		if (approvedPaths.has(declaredPath) && canonicalPath !== declaredPath) {
			throw new CodingToolError(
				"approved-path-changed",
				"An approved path changed before execution.",
				{ recovery: { action: "reread", path: declaredPath } }
			);
		}
		canonicalByDeclared.set(declaredPath, canonicalPath);
		canonicalPaths.push(canonicalPath);
	}
	const leasePaths = [...new Set(canonicalPaths)].sort();
	return withLeases(context, leasePaths, (assertLease) =>
		withMutationLocks(leasePaths, async () => {
			await assertCanonicalPaths(
				declaredPaths,
				canonicalByDeclared,
				options.allowExternalPath === true
			);
			const plans = await planFiles(
				input,
				context,
				limits,
				canonicalByDeclared
			);
			assertLease();
			return executePlans(context, limits, plans, assertLease);
		})
	);
};

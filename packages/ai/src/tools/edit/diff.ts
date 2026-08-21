import { createTwoFilesPatch, parsePatch } from "diff";
import type { EditDiff } from "./schema";

export const EDIT_DIFF_MAX_BYTES = 256 * 1024;
export const EDIT_DIFF_MAX_LINES = 2000;

const PATCH_CONTENT_PREFIX_RE = /^[+\- ]/u;
const LEADING_WHITESPACE_RE = /^\s*/u;
type PatchHunks = {
	header: string[];
	hunks: string[][];
};

const normalizeLineEndings = (content: string): string =>
	content.replace(/\r\n?/gu, "\n");

const patchLineCount = (patch: string): number =>
	patch.length === 0
		? 0
		: patch.split("\n").length - (patch.endsWith("\n") ? 1 : 0);

const patchByteLength = (patch: string): number =>
	new TextEncoder().encode(patch).byteLength;

const countChanges = (patch: string) => {
	let additions = 0;
	let deletions = 0;
	let inHunk = false;

	for (const line of patch.split("\n")) {
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}
		if (!inHunk) {
			continue;
		}
		if (line.startsWith("+")) {
			additions += 1;
		} else if (line.startsWith("-")) {
			deletions += 1;
		}
	}

	return { additions, deletions };
};

const trimDiff = (patch: string): string => {
	const lines = patch.split("\n");
	let minimumIndent: number | undefined;

	for (const line of lines) {
		if (
			line.startsWith("---") ||
			line.startsWith("+++") ||
			!PATCH_CONTENT_PREFIX_RE.test(line)
		) {
			continue;
		}

		const content = line.slice(1);
		if (content.trim().length === 0) {
			continue;
		}

		const indent = content.match(LEADING_WHITESPACE_RE)?.[0].length ?? 0;
		minimumIndent =
			minimumIndent === undefined ? indent : Math.min(minimumIndent, indent);
	}

	if (minimumIndent === undefined || minimumIndent === 0) {
		return patch;
	}

	return lines
		.map((line) => {
			if (
				line.startsWith("---") ||
				line.startsWith("+++") ||
				!PATCH_CONTENT_PREFIX_RE.test(line)
			) {
				return line;
			}
			return `${line[0]}${line.slice(1 + minimumIndent)}`;
		})
		.join("\n");
};

const splitPatchHunks = (patch: string): PatchHunks => {
	const lines = patch.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}

	const hunkStarts = lines.flatMap((line, index) =>
		line.startsWith("@@") ? [index] : []
	);
	if (hunkStarts.length === 0) {
		return { header: lines, hunks: [] };
	}

	return {
		header: lines.slice(0, hunkStarts[0]),
		hunks: hunkStarts.map((start, index) =>
			lines.slice(start, hunkStarts[index + 1] ?? lines.length)
		),
	};
};

const renderPatch = (header: string[], hunks: string[][]): string => {
	if (hunks.length === 0) {
		return "";
	}
	return `${[...header, ...hunks.flat()].join("\n")}\n`;
};

const isWithinLimits = (patch: string): boolean =>
	patchByteLength(patch) <= EDIT_DIFF_MAX_BYTES &&
	patchLineCount(patch) <= EDIT_DIFF_MAX_LINES;

const isValidPatch = (patch: string): boolean => {
	if (patch.length === 0) {
		return true;
	}

	try {
		const parsed = parsePatch(patch);
		return parsed.length === 1 && (parsed[0]?.hunks.length ?? 0) > 0;
	} catch {
		return false;
	}
};

const selectTruncatedHunks = ({
	header,
	hunks,
}: PatchHunks): { patch: string; omittedHunks: number } => {
	const firstBudgetBytes = Math.floor(EDIT_DIFF_MAX_BYTES * 0.75);
	const firstBudgetLines = Math.floor(EDIT_DIFF_MAX_LINES * 0.75);
	const selected = new Set<number>();

	for (let index = 0; index < hunks.length; index += 1) {
		const candidate = [...selected, index].sort((left, right) => left - right);
		const candidatePatch = renderPatch(
			header,
			candidate.map((hunkIndex) => hunks[hunkIndex] ?? [])
		);
		if (
			patchByteLength(candidatePatch) > firstBudgetBytes ||
			patchLineCount(candidatePatch) > firstBudgetLines
		) {
			break;
		}
		selected.add(index);
	}

	for (let index = hunks.length - 1; index >= 0; index -= 1) {
		if (selected.has(index)) {
			continue;
		}

		const candidate = [...selected, index].sort((left, right) => left - right);
		const candidatePatch = renderPatch(
			header,
			candidate.map((hunkIndex) => hunks[hunkIndex] ?? [])
		);
		if (isWithinLimits(candidatePatch)) {
			selected.add(index);
		}
	}

	if (selected.size === 0) {
		for (let index = 0; index < hunks.length; index += 1) {
			const candidatePatch = renderPatch(header, [hunks[index] ?? []]);
			if (isWithinLimits(candidatePatch)) {
				selected.add(index);
				break;
			}
		}
	}

	const selectedHunks = [...selected].sort((left, right) => left - right);
	return {
		omittedHunks: hunks.length - selectedHunks.length,
		patch: renderPatch(
			header,
			selectedHunks.map((index) => hunks[index] ?? [])
		),
	};
};

export const buildEditDiff = (
	before: string,
	after: string,
	filePath: string
): EditDiff => {
	const normalizedBefore = normalizeLineEndings(before);
	const normalizedAfter = normalizeLineEndings(after);
	const patchPath = filePath.replace(/[\r\n]/gu, "");
	// Show four additional unchanged lines above and below the default context.
	const rawPatch = createTwoFilesPatch(
		patchPath,
		patchPath,
		normalizedBefore,
		normalizedAfter,
		undefined,
		undefined,
		{ context: 8 }
	);
	const trimmedPatch = trimDiff(rawPatch);
	const { additions, deletions } = countChanges(trimmedPatch);
	const { header, hunks } = splitPatchHunks(trimmedPatch);

	if (hunks.length === 0) {
		return {
			additions,
			deletions,
			omittedHunks: 0,
			patch: "",
			truncated: false,
		};
	}

	const fullPatch = renderPatch(header, hunks);
	if (!isValidPatch(fullPatch)) {
		throw new Error("Generated edit diff is invalid.");
	}

	if (isWithinLimits(fullPatch)) {
		return {
			additions,
			deletions,
			omittedHunks: 0,
			patch: fullPatch,
			truncated: false,
		};
	}

	const truncated = selectTruncatedHunks({ header, hunks });
	if (!isValidPatch(truncated.patch)) {
		return {
			additions,
			deletions,
			omittedHunks: hunks.length,
			patch: "",
			truncated: true,
		};
	}

	return {
		additions,
		deletions,
		omittedHunks: truncated.omittedHunks,
		patch: truncated.patch,
		truncated: true,
	};
};

export const isRenderableEditDiff = (value: unknown): value is EditDiff => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.patch !== "string" ||
		typeof candidate.additions !== "number" ||
		!Number.isInteger(candidate.additions) ||
		candidate.additions < 0 ||
		typeof candidate.deletions !== "number" ||
		!Number.isInteger(candidate.deletions) ||
		candidate.deletions < 0 ||
		typeof candidate.truncated !== "boolean" ||
		typeof candidate.omittedHunks !== "number" ||
		!Number.isInteger(candidate.omittedHunks) ||
		candidate.omittedHunks < 0
	) {
		return false;
	}

	if (
		candidate.patch.length > 0 &&
		!(isWithinLimits(candidate.patch) && isValidPatch(candidate.patch))
	) {
		return false;
	}

	return true;
};

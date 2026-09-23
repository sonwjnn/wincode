import { createHash } from "node:crypto";
import type { Tagged } from "type-fest";
import { z } from "zod";

export const FILE_VERSION_ALGORITHM = "sha256-128" as const;
export const FILE_VERSION_BYTES = 16 as const;
export const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

export const fileVersionSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export type FileVersion = Tagged<string, "FileVersion">;

export type LineEnding = "" | "\n" | "\r" | "\r\n";

export type LineRange = Readonly<{
	endLine?: number;
	startLine: number;
}>;
export const lineRangeSchema = z
	.object({
		endLine: z.number().int().positive().optional(),
		startLine: z.number().int().positive(),
	})
	.strict()
	.refine(
		(range) => range.endLine === undefined || range.endLine >= range.startLine,
		"Line ranges must be ordered."
	);

export type LosslessTextLine = Readonly<{
	ending: LineEnding;
	lineNumber: number;
	text: string;
}>;

export type LosslessText = Readonly<{
	hasBom: boolean;
	hasTrailingNewline: boolean;
	lines: readonly LosslessTextLine[];
}>;

const textEncoder = new TextEncoder();

const isUtf8Bom = (bytes: Uint8Array): boolean =>
	bytes.length >= UTF8_BOM.length &&
	bytes[0] === UTF8_BOM[0] &&
	bytes[1] === UTF8_BOM[1] &&
	bytes[2] === UTF8_BOM[2];

const utf8Body = (bytes: Uint8Array): Uint8Array =>
	isUtf8Bom(bytes) ? bytes.subarray(UTF8_BOM.length) : bytes;

const pushLine = (
	lines: LosslessTextLine[],
	text: string,
	ending: LineEnding
): void => {
	lines.push({ ending, lineNumber: lines.length + 1, text });
};

/**
 * Decodes one exact UTF-8 file body without normalising line endings. A BOM is
 * metadata, not part of the first line. NUL-bearing content is rejected here
 * because it is not safe to address with the line-editing protocol.
 */
export const decodeLosslessText = (bytes: Uint8Array): LosslessText => {
	let value: string;
	try {
		value = new TextDecoder("utf-8", { fatal: true }).decode(utf8Body(bytes));
	} catch {
		throw new Error("Cannot edit file: invalid UTF-8.");
	}
	if (value.includes("\0")) {
		throw new Error(
			"Cannot edit file: NUL-bearing content is not line-editable."
		);
	}

	const lines: LosslessTextLine[] = [];
	let lineStart = 0;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (character === "\n") {
			pushLine(lines, value.slice(lineStart, index), "\n");
			lineStart = index + 1;
			continue;
		}
		if (character !== "\r") {
			continue;
		}
		const isCrLf = value[index + 1] === "\n";
		pushLine(lines, value.slice(lineStart, index), isCrLf ? "\r\n" : "\r");
		lineStart = index + (isCrLf ? 2 : 1);
		if (isCrLf) {
			index += 1;
		}
	}
	if (lineStart < value.length) {
		pushLine(lines, value.slice(lineStart), "");
	}

	return {
		hasBom: isUtf8Bom(bytes),
		hasTrailingNewline: (lines.at(-1)?.ending.length ?? 0) > 0,
		lines,
	};
};

/** Re-encodes the lossless representation without changing its byte model. */
export const encodeLosslessText = (text: LosslessText): Uint8Array => {
	const body = text.lines.map((line) => `${line.text}${line.ending}`).join("");
	const bodyBytes = textEncoder.encode(body);
	if (!text.hasBom) {
		return bodyBytes;
	}
	const bytes = new Uint8Array(UTF8_BOM.length + bodyBytes.length);
	bytes.set(UTF8_BOM, 0);
	bytes.set(bodyBytes, UTF8_BOM.length);
	return bytes;
};

/** Computes the content identity from exact on-disk bytes. */
export const computeFileVersion = (bytes: Uint8Array): FileVersion =>
	createHash("sha256")
		.update(bytes)
		.digest()
		.subarray(0, FILE_VERSION_BYTES)
		.toString("hex") as FileVersion;

export const byteLength = (value: string): number =>
	textEncoder.encode(value).byteLength;

export const normalizeLineRanges = (
	ranges: readonly LineRange[]
): LineRange[] => {
	const ordered = ranges
		.map((range) => ({
			endLine: range.endLine ?? range.startLine,
			startLine: range.startLine,
		}))
		.sort((left, right) => left.startLine - right.startLine);
	const merged: Array<{ endLine: number; startLine: number }> = [];
	for (const range of ordered) {
		const previous = merged.at(-1);
		if (previous && range.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, range.endLine);
			continue;
		}
		merged.push(range);
	}
	return merged;
};

export const lineRangeContains = (
	range: LineRange,
	lineNumber: number
): boolean =>
	lineNumber >= range.startLine &&
	lineNumber <= (range.endLine ?? range.startLine);

export const lineRangesContain = (
	ranges: readonly LineRange[],
	lineNumber: number
): boolean => ranges.some((range) => lineRangeContains(range, lineNumber));

export const lineRangeForLines = (
	lineNumbers: readonly number[]
): LineRange[] => {
	if (lineNumbers.length === 0) {
		return [];
	}
	const ordered = [...new Set(lineNumbers)].sort((left, right) => left - right);
	const ranges: Array<{ endLine: number; startLine: number }> = [];
	for (const lineNumber of ordered) {
		const previous = ranges.at(-1);
		if (previous && lineNumber === previous.endLine + 1) {
			previous.endLine = lineNumber;
			continue;
		}
		ranges.push({ endLine: lineNumber, startLine: lineNumber });
	}
	return ranges.map((range) =>
		range.startLine === range.endLine ? { startLine: range.startLine } : range
	);
};
